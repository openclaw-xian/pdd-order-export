# 实现说明（pdd-order-export）

## 结构

```
run.mjs            普通 Node 调度器：预检 → 逐店 spawn worker（串行）→ 汇总 report
worker-order.mjs   ego 进程内：找店 → 日期 → 查询 → 批量导出 → 下载 → 归档/元数据
```

## 调度器（run.mjs）

1. 读 config：`from/to/root/shops|_stores.json/ego/worker`
2. 预检：日期格式/倒挂/未来；根目录（非 C 盘缺失自动创建）；ego 可用；店铺清单
   - 店铺来源：config `shops` > `<root>/_stores.json` > **自动扫描 ego profiles 生成清单**（`STORES_DISCOVERED`，空结果重试一次）；`refreshStores:true` 强制重扫；仍无 → `stores_config_missing`
   - 问题 → `PREFLIGHT=needs_user_input`，退出码 3
3. 期间目录/标签：整月 `YYYY-MM` / `<M>月`；区间 `from_to` / `<M月D日-M月D日>`
4. 按 `concurrency`（默认 1，最大 6）并行跑店；每店 worker 独立 claim 空间
   - 下载步骤用全局锁 `_state/order-download.lock` 串行，避免共享 Downloads 抢文件
   - 需要每店空间标签页 ≤6（ego 上限 8）；用户/历史标签页需先清理
5. 汇总 `report.json` / `summary.txt`；`needs` → 退出码 4；`failed` → 退出码 5
   - `retries`（默认 1）：对 `export_page_not_found`/`page label`/下载类瞬时错误再跑一次

## worker（worker-order.mjs）

1. **找店**：按 `profileName` 匹配空间 → 打开订单页 → `.user-name-text` 读店铺名；空间不存在时用 `profiles()` 的 profileId **重建 task space**；仍不符 → 扫描 profiles → 更新 `_stores.json`；再不行 → `shop_not_logged_in`
   - 强制确认「全部订单」页签：URL 含 `tab=0`，否则点页签；再校验
   - 强制确认状态筛选：订单状态/售后状态=全部、超时状态=不限；否则 `status_filter_not_all`
2. **日期**：
   - 计算 `endPlus = to + 1 天`（因为结束 00:00 不含当天）
   - 打开 RPR 面板（`page.mouse` 循环点 + 检测 wrapper）
   - `setPanel(left/right, targetMonth)`：点箭头，面板可能关闭，循环重开并回读 `headerSelector` 月份
   - 左表选起日、右表选止日（同月则在左表选两天）
   - `归零` → `确认` → 回读日期输入 `YYYY-MM-DD 00:00:00 ~ ...`
   - 面板中途关闭会重开；不一致重试最多 3 次，确认后再补点一次；仍不一致抛 `date_not_applied`
3. **查询**：点「查询」→ 读 `共查询到 N 个订单`
4. **导出**：
   - 点「批量导出」→ 等弹窗
   - 若 `reuseExisting:true`：生成前先打开导出页，找同日期范围报表直接下载（默认关闭，避免旧报表）
   - 生成前按 `_state/cooldowns/<店铺>.json` 等冷却（`waitCooldown`/`cooldownSec`）
   - 生成页没开出来 → 当前页打开 `/orders/exportExcel`，**只选日期范围匹配的报表下载**（复用已有任务）
   - 点「生成报表」→ 等新标签页 `/orders/exportExcel?exportType=0`（popup 或 task.tabs 兜底）；若弹窗提示 5 分钟间隔 → `rate_limited`
   - 若出现「请向右滑块完成拼图」→ `captcha_required`（人工处理，不重试）
   - 等匹配日期范围的「下载报表」按钮（最长 30s）
   - 记录 Downloads 现有文件 → 点下载一次 → 轮询新增 `orders_export` 文件（最长 30s）
   - **主路径**：`expPage.waitForEvent("download")` → `download.saveAs(dest)`；事件不可用才回退 Downloads 轮询
   - 下载/复制期间持有 `_state/order-download.lock`（跨进程文件锁），兜底路径单店下载串行
   - **先结束 task 关闭页面释放文件句柄**，再复制；下载文件大小需稳定
5. **归档**：
   - 等文件可读（大小稳定）→ `copyFile` 到 `<periodDir>/<店铺>-订单-<label>.csv`，再删源文件
   - 失败重试 40×500ms，超时 `download_copy_failed`
   - 目标被 Excel/WPS 占用（EBUSY/EPERM）→ 自动改写到 `<名字>.new-<时间>.csv`，继续成功；`订单信息.md` 记录实际文件名
6. **元数据 + 校验**：
   - 读 CSV（UTF-8 BOM，支持引号/换行），统计去重订单号、行数、实付/实收、状态分布、日期范围、SHA-256
   - **校验**：页面查询单量 == CSV 去重订单号；CSV 日期在 `from~to`；不一致失败
   - 写 `订单信息.md`（含查询单量、多行订单、数据日期、下载源、目标锁、同期文件）
7. **失败证据**：异常时截图 + 写 `failure-*.json`（URL/tabs/正文），路径进 report
8. 结果：`{status, orders, csvRows, csvName, path, paySum, recvSum, sha256, dateMin, dateMax, multiRow}`

## 日期算法要点

- 面板打开：真实鼠标事件；`page.click` 不稳定
- 切月：点箭头后面板会关闭但月份已变 → 下一轮重开、再回读
- 日期格：排除 `RPR_outOfMonth` / `RPR_disabled`
- 结束日左闭右开 → 必须 +1 天，否则漏最后一天（实测 10 月漏 55 单）

## doctor（只读自检）

- 配置 `doctor:true` 或 `mode:"doctor"`；runner 逐店串行跑 worker `mode:"doctor"`，输出 `DOCTOR_RESULT`。
- worker：找店 → 校验全部订单/状态筛选 → 选日期并回读 → 查询计数；**不导出、不下载、不写账单目录**。
- 退出码：全部通过 0，否则 1。

## 维护指南

| 变的东西 | 改哪里 |
|---|---|
| 页面 URL | `worker-order.mjs` 里的 orders URL |
| 店铺名元素 | `readShopName()` 的 `.user-name-text` |
| 日期面板/箭头/日期格 | `openPanel`、`header`、`arrows`、`setPanel`、`cellRect` |
| 查询文案/计数 | `queryCount()` 的正则 |
| 导出弹窗/生成报表/下载页 | `exportOrders()` |
| 下载目录/文件名 | `exportOrders()` 的 DOWNLOADS 与 `orders_export` |
| CSV 字段/命名 | `writeOrderInfo()`、`JOB.csvName` |
