/** @typedef {{id:number, title:string, payload:object, author:string}} BusinessCase */
/** @typedef {{id:number, case_id:number, status:'queued'|'running'|'complete'|'failed'}} Run */
/** @typedef {{id:number, run_id:number, digest:string, report:{summary:string, metrics:object, sections:Array}}} Evidence */
/** @typedef {{id:number, case_id:number, parent:string, component:string, old_qty:string, new_qty:string, note:string, actor:string, created_at:string}} Errata */
/** @typedef {{id:number, errata_id:number, run_id:number, detail:{rows:Array}, actor:string, created_at:string}} Compensation */
