import hashlib
import uuid

from fastapi import HTTPException
from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError

from src.config.settings import cache, engine
from src.constants.workflow import Status
from src.models.tables import audit, cases, compensations, errata, evidence, runs
from src.services import domain
from src.utils.encoding import canonical
from src.utils.time import utc_time


def log(conn, actor, action, reference):
    conn.execute(audit.insert().values(actor=actor, action=action, reference=str(reference), created_at=utc_time()))


def recent(table):
    with engine.connect() as conn:
        return [dict(row) for row in conn.execute(select(table).order_by(table.c.id.desc()).limit(100)).mappings()]


def found(conn, table, identity):
    row = conn.execute(select(table).where(table.c.id == identity)).mappings().first()
    if row is None:
        raise HTTPException(404, '找不到该记录')
    return dict(row)


def make_case(title, payload, actor):
    title = title.strip()
    if not title:
        raise HTTPException(422, '档案名称不能为空')
    try:
        if len(canonical(payload)) > 512 * 1024:
            raise ValueError('业务输入超过 512 KiB')
        if callable(getattr(domain, 'validate', None)):
            domain.validate(payload)
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, str(exc)) from None
    with engine.begin() as conn:
        case_id = conn.execute(cases.insert().values(slug=uuid.uuid4().hex, title=title, payload=payload,
                               author=actor, created_at=utc_time())).inserted_primary_key[0]
        log(conn, actor, 'create_case', case_id)
        return found(conn, cases, case_id)


def enqueue(case_id, actor):
    with engine.begin() as conn:
        found(conn, cases, case_id)
        run_id = conn.execute(runs.insert().values(case_id=case_id, status=Status.QUEUED,
                              owner=actor, created_at=utc_time())).inserted_primary_key[0]
        log(conn, actor, 'enqueue', run_id)
        result = found(conn, runs, run_id)
    try:
        cache.lpush('worker:wake', 'queued')
        cache.ltrim('worker:wake', 0, 99)
    except Exception:
        # The durable database queue is polled even if Redis is temporarily unavailable.
        pass
    return result


def claim():
    ready = or_(runs.c.status == Status.QUEUED,
                and_(runs.c.status == Status.RUNNING, runs.c.started_at < utc_time(-600)))
    with engine.begin() as conn:
        run = conn.execute(select(runs.c.id, runs.c.case_id, runs.c.created_at)
                           .where(ready).order_by(runs.c.id)
                           .limit(1).with_for_update(skip_locked=True)).first()
        if not run:
            return None
        token = str(uuid.uuid4())
        conn.execute(runs.update().where(runs.c.id == run.id).values(
            started_at=utc_time(), status=Status.RUNNING, attempt_token=token))
        payload = found(conn, cases, run.case_id)['payload']
        # Ratios snapshot at enqueue time: batches already queued or running keep
        # the original ratios; only errata registered before enqueue apply.
        corrections = conn.execute(
            select(errata).where(errata.c.case_id == run.case_id,
                                 errata.c.created_at <= run.created_at)
            .order_by(errata.c.id)).mappings().all()
        return run.id, token, domain.apply_errata(payload, corrections)


def finish(run_id, token, result=None, error=None):
    digest = hashlib.sha256(canonical(result)).hexdigest() if result is not None else None
    status = Status.FAILED if error else Status.COMPLETE
    with engine.begin() as conn:
        count = conn.execute(runs.update().where(runs.c.id == run_id,
                        runs.c.attempt_token == token, runs.c.status == Status.RUNNING)
                        .values(status=status, finished_at=utc_time(), error=error)).rowcount
        if not count:
            return
        if result is not None:
            conn.execute(evidence.insert().values(run_id=run_id, report=result, digest=digest))
        log(conn, 'worker', status.value, run_id)


def review(identity, note, actor):
    note = note.strip()
    if not note:
        raise HTTPException(422, '复核意见不能为空')
    with engine.begin() as conn:
        found(conn, evidence, identity)
        count = conn.execute(evidence.update().where(evidence.c.id == identity, evidence.c.reviewed_at.is_(None))
                            .values(review_note=note, reviewer=actor, reviewed_at=utc_time())).rowcount
        if count != 1:
            raise HTTPException(409, '该证据已经复核')
        log(conn, actor, 'review', identity)
        return found(conn, evidence, identity)


def register_errata(case_id, form, actor):
    try:
        parent = domain.code_text(form.parent, '上级配方编号')
        component = domain.code_text(form.component, '下级配方或原料编号')
        new_qty = domain.ratio_text(form.qty)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    note = form.note.strip()
    with engine.begin() as conn:
        case = found(conn, cases, case_id)
        edge = next((row for row in case['payload'].get('components', [])
                     if row.get('parent') == parent and row.get('component') == component), None)
        if edge is None:
            raise HTTPException(422, f'档案中不存在 {parent} → {component} 的投料关系。')
        prior = conn.execute(select(errata.c.new_qty).where(
            errata.c.case_id == case_id, errata.c.parent == parent,
            errata.c.component == component).order_by(errata.c.id)).scalars().all()
        current = prior[-1] if prior else domain.ratio_text(edge.get('qty'))
        if new_qty == current:
            raise HTTPException(409, f'该投料关系当前比例已是 {new_qty}，无需勘误。')
        errata_id = conn.execute(errata.insert().values(
            case_id=case_id, parent=parent, component=component, old_qty=current,
            new_qty=new_qty, note=note, actor=actor, created_at=utc_time())).inserted_primary_key[0]
        log(conn, actor, 'register_errata', errata_id)
        return found(conn, errata, errata_id)


def issue_compensation(errata_id, actor):
    """Add compensation rows for old orders of one errata; safe to retry.

    Only orders enqueued before the errata and already issued (complete) are
    compensated, and only when they actually walked the corrected relationship
    on a counted path. Late-issued old orders are picked up by the next call;
    the (errata_id, run_id) uniqueness keeps retries from duplicating rows.
    """
    with engine.connect() as conn:
        correction = found(conn, errata, errata_id)
        case = found(conn, cases, correction['case_id'])
        chain = conn.execute(select(errata).where(errata.c.case_id == case['id'])
                             .order_by(errata.c.id)).mappings().all()
        candidates = conn.execute(select(runs).where(
            runs.c.case_id == case['id'], runs.c.created_at < correction['created_at'],
            runs.c.status == Status.COMPLETE).order_by(runs.c.id)).mappings().all()
        done = set(conn.execute(select(compensations.c.run_id)
                                .where(compensations.c.errata_id == errata_id)).scalars())
    rows = []
    for run in candidates:
        if run['id'] in done:
            continue
        earlier = [entry for entry in chain if entry['created_at'] <= run['created_at']]
        payload = domain.apply_errata(case['payload'], earlier)
        detail = domain.compensation(payload, correction['parent'], correction['component'],
                                     correction['old_qty'], correction['new_qty'], engine)
        if detail is None:
            continue
        rows.append({'errata_id': errata_id, 'run_id': run['id'], 'detail': detail,
                     'actor': actor, 'created_at': utc_time()})
    with engine.begin() as conn:
        done = set(conn.execute(select(compensations.c.run_id)
                                .where(compensations.c.errata_id == errata_id)).scalars())
        issued = 0
        try:
            for row in rows:
                if row['run_id'] in done:
                    continue
                conn.execute(compensations.insert().values(**row))
                issued += 1
        except IntegrityError:
            raise HTTPException(409, '补差正在并发生成，请刷新后查看。') from None
        log(conn, actor, 'compensate', errata_id)
        return {'errata': found(conn, errata, errata_id), 'issued': issued,
                'compensations': [dict(row) for row in conn.execute(
                    select(compensations).where(compensations.c.errata_id == errata_id)
                    .order_by(compensations.c.id)).mappings()]}
