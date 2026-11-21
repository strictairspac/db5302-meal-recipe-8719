# 初始结构

`src/models/tables.py` 定义初始关系结构。API 启动时显式创建演示库的表；此版本只包含初始 schema。需要在已有部署升级表结构时，应单独引入版本化迁移。

配比勘误新增的 `recipe_errata` 与 `purchase_compensations` 两表同样由启动时的 `create_all` 在缺失时创建，不改动既有表。
