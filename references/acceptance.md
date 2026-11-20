# 交付验收清单（Definition of Done）

## 1. 交付项

| # | 项 | 位置 | 状态 |
|---|---|---|---|
| 1 | 触发/入口 | `SKILL.md` | ✅ |
| 2 | 前置条件 + 预检 | `SKILL.md` / `run.mjs` | ✅ |
| 3 | 用法与示例 | `examples/` | ✅ |
| 4 | 页面契约（日期/导出/下载） | `references/dom-contract.md` | ✅ |
| 5 | 实现流程 | `references/implementation.md` | ✅ |
| 6 | 踩坑表 | `references/pitfalls.md` | ✅ |
| 7 | 测试数字 | `references/testing.md` | ✅ |
| 8 | 失败/needs/退出码 | `SKILL.md` / `run.mjs` | ✅ |
| 9 | 输出命名 | `SKILL.md` | ✅ |
| 10 | 无真实店铺名/账号/绝对路径 | 全目录抽查 | ✅（示例占位） |
| 11 | 陌生人走查 | §2 | ✅（见 §4） |

## 2. 陌生人走查

1. 复制/联接目录到 `~/.agents/skills/pdd-order-export`
2. `node --check run.mjs worker-order.mjs`
3. 准备 `_stores.json` 或 config `shops`
4. `node run.mjs order-config.json`（整月）
5. 检查 `<root>/<店铺>/<期间>/`：CSV + `订单信息.md`
6. 核对 CSV 行数/订单数/实付/实收
7. 改区间（跨月/任意日）再跑，确认结束日 +1 天
8. 未登录店铺 → `NEEDS` + exit 4；缺配置 → `PREFLIGHT` + exit 3

## 3. 状态

| 输出 | 含义 |
|---|---|
| `PREFLIGHT=needs_user_input`（exit 3） | 配置/环境问题 |
| `NEEDS=needs_user_action`（exit 4） | 店铺未登录/找不到 |
| `FAILED=job_failed`（exit 5） | 任务失败 |
| `status=done` | 成功，CSV+订单信息已归档 |

## 4. 验收记录

- **0.1.0（2026-11-20）**：2026-10 全月 `2026-10-01 ~ 2026-11-01 00:00` 查询 1488 单；对账报表导出 CSV（UTF-8 BOM，615,335 B，SHA-256 `7d6e5aa0...`）；归档 `枝枝家居-订单-10月.csv` + `订单信息.md`。
- **skill 全链路（0.1.0/0.1.1）**：临时 root `D:/_order-test` 自动创建；`status=done`、1488 单、20.5s；CSV/MD 与手工导出一致；启动校验 `tab=0`、状态全部/不限。
- **doctor（0.1.2）**：2026-10 只读自检 `doctor_ok`、1488 单、12.1s；不导出、不写账单目录。
- **自动兜底（0.1.3）**：无 shops/清单时自动扫 profiles；目标 CSV 被占用改写 `.new-<时间>.csv`；导出间隔不足返回 `rate_limited`。
- **滑块验证（0.1.5）**：识别「请向右滑块完成拼图」，返回 `captcha_required`（needs/exit 4），要求人工完成；不自动绕过。
- **多店全链路（0.1.7）**：无 shops 自动发现 3 店；一次跑通 碧竹 457 / 枝枝 1488 / 鱼越 484，全部 done。
- **稳定性优化（0.2.0）**：冷却等待 + 同区间报表复用 + 查询单量/CSV 去重/日期范围校验 + 失败截图/证据 + 页面预算 needs。
- **并行多店（0.3.0）**：清理标签后 `concurrency:3` 跑 3 店全部 done；下载锁串行，总耗时约 25s。
- **download 事件 + 空间重建（0.4.0）**：空间被关后按 profile 重建；3 店并行全部 done（27.5/36.6/45.6s）；下载走 `download.saveAs`。
- **复用/重试/锁（0.4.1）**：`reuseExisting` 复用报表 done 22.1s；目标文件锁自动 `.new` done 22.8s；retries 代码已加。
- 日期证据：10 月 1433（漏 10/31）/ 1488（完整）；10/31 单日 55；9 月全月 1428；9/15~10/15 1263。
- 已知限制：3 个月前订单/跨年未测；导出 5 分钟间隔；目标文件被 Excel 占用会锁。
