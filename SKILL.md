---
name: pdd-order-export
description: 拼多多多店铺「订单查询 + 批量导出」（对账报表）。按店铺 × 期间打开商家后台订单查询，切到全部订单，状态全部，按目标日期（结束日 +1 天，00:00:00）查询，点批量导出 → 对账报表 → 生成报表 → 下载报表，把 CSV 归档到 <账单根目录>\<店铺>\<期间>\<店铺>-订单-<月>月.csv，并生成 订单信息.md（单量/实付/实收/状态分布/哈希）。Use when 用户要导出拼多多订单明细、对账报表、按店铺按月归档订单数据。
---

# pdd-order-export — 订单查询 + 批量导出

> 本 skill 不含真实店铺名/账号/本机绝对路径；真实店铺清单在用户数据目录。
>
> - `references/dom-contract.md` — 订单页/日期面板/导出弹窗/下载页的 DOM 契约
> - `references/implementation.md` — 调度器 + worker 流程、日期算法、下载归档、维护指南
> - `references/testing.md` — 实测日期/单量/文件证据
> - `references/pitfalls.md` — 方法、用法、踩过的坑
> - `references/acceptance.md` — 验收清单与陌生人走查

## 前置条件

- Windows + ego-browser（各店 profile 已登录）
- Node.js
- 账单根目录：默认 `D:/对账账单`（`root` 可改；非 C 盘不存在会自动创建；C 盘需 `allowC:true`）
- 店铺清单：`<root>/_stores.json` 或 config `shops`（`profile` 可省略，worker 会自己扫）

## 用法

```bash
node <skill目录>/run.mjs <config.json>
```

最小配置：

```json
{
  "from": "2026-10-01",
  "to": "2026-10-31",
  "root": "D:/对账账单",
  "shops": [
    { "shop": "<店铺A>", "profile": "<profile-A>" }
  ]
}
```

- `shops` 也可只写店铺名；或从 `<root>/_stores.json` 读取
- **两者都没有时**：自动扫描 ego profiles 生成 `_stores.json`（`STORES_DISCOVERED`）
- 默认**串行**执行（下载目录共享，避免并发拿错文件）
- worker 会强制确认：全部订单页签（`tab=0`）+ 订单状态/售后状态=全部 + 超时状态=不限；不满足直接失败
- 当前只支持「全部订单(近3个月)」范围：区间 ≤92 天且起始日不早于今天−92 天；更早日期未实现

## 自检 doctor（只读，不导出）

```bash
node <skill目录>/run.mjs doctor.json
```

```json
{ "doctor": true, "from": "2026-10-01", "to": "2026-10-31", "shops": [{ "shop": "<店铺A>", "profile": "<profile-A>" }] }
```

- 检查：找店、全部订单页签、状态全部/不限、日期选择+回读、查询计数
- **不批量导出、不下载、不写账单目录**
- 输出 `DOCTOR_RESULT`；全部通过退出码 0，否则 1

## 输出

```
<root>\<店铺>\<期间>\
├─ <店铺>-订单-<月>月.csv       # 对账报表 CSV（UTF-8 BOM）；若目标被 Excel 占用，会写 .new-<时间>.csv
└─ 订单信息.md                  # 单量/金额/状态/来源/哈希
```

- 期间目录：整月 `YYYY-MM`；区间 `YYYY-MM-DD_YYYY-MM-DD`
- 命名：整月 `<店铺>-订单-<M>月.csv`；区间 `<店铺>-订单-<M月D日-M月D日>.csv`
- CSV 里包含对账报表字段：商品/订单号/状态/商品总价/邮费/店铺优惠/平台优惠/用户实付/商家实收/发货/收货/售后等

## 日期规则（最重要）

- 页面结束时间 `00:00:00` **不含结束日**（左闭右开）
- 所以一律：**起日 00:00:00，结束日 = 目标止日 + 1 天 00:00:00**
  - 10 月：`2026-10-01 00:00:00 ~ 2026-11-01 00:00:00`
  - 9/15~10/15：`2026-09-15 00:00:00 ~ 2026-10-16 00:00:00`
- 日期面板里点「归零」把起止时间都设 00:00:00，不再碰时间三列
- 选完必须点「确认」，并回读日期输入；不一致就停下，绝不带错日期查询

## 导出规则

- 「批量导出」弹窗选 **对账报表**（含订单金额字段）
- 点「生成报表」会新开标签页 `/orders/exportExcel?exportType=0`
- 等「下载报表」出现后点一次；文件下载到系统 Downloads（随机前缀 + `orders_export<时间>.csv`）
- 平台限制：单次区间 ≤3 个月；两次导出间隔 ≥5 分钟；任务保留 24 小时（可在「已生成报表」重下）
- 下载文件可能仍被浏览器占用：必须等大小稳定后再复制，失败重试

## 条件不满足时

- 店铺未登录/找不到 → `NEEDS=needs_user_action`（退出码 4），带 question + availableProfiles；让用户登录后重跑
- 日期/根目录/ego/清单问题 → `PREFLIGHT=needs_user_input`（退出码 3）
- 失败 → `FAILED=job_failed`（退出码 5）

## 红线

1. 不落 C 盘（默认拒绝）
2. 不代登录
3. 导出只点一次「下载报表」，不重复点
4. 日期必须回读校验；结束日必须 +1 天
5. 一店一目录、一期一目录；CSV 命名固定

## 排障

| 现象 | 处理 |
|---|---|
| `download_copy_failed` | 下载文件被占用；worker 已重试；仍失败就稍后重跑（别重复下载） |
| 生成报表无反应/新页没开 | 等弹窗「生成报表」按钮可用；检查 5 分钟导出间隔限制 |
| 日期面板月份切不动 | 箭头点击会关闭面板；worker 会重开并回读月份 |
| `order_count_not_found` | 查询没出「共查询到 N 个订单」；检查筛选/日期 |
| `status_filter_not_all` | 订单状态/售后状态不是全部、或超时不是不限；手动改回后重跑 |
| `not_all_orders_tab` | 没停在全部订单页签；worker 会点击并校验，仍失败就手动切 |
| `range_too_long` / `range_older_than_3_months` | 超出当前 skill 的 3 个月范围；缩短区间 |
| `rate_limited` | 两次导出间隔不足 5 分钟；等 5 分钟后再跑 |
| 目标 CSV 被 Excel/WPS 打开 | worker 自动改写为 `.new-<时间>.csv` 并继续，`订单信息.md` 会记录实际文件名 |
| 页面预算(8/8) | 关闭多余标签页后重跑；worker 结束会 `finish` 释放 |

## 版本

`VERSION` / `CHANGELOG.md`；改版维护见 `references/implementation.md`。
