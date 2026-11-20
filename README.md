# pdd-order-export

拼多多多店铺「订单查询 + 批量导出」（对账报表）—— **DeepSeek Harness (DSH) skill**。

按店铺 × 期间打开订单查询，切全部订单、状态全部，按目标日期（结束日 +1 天）查询，批量导出「对账报表」，下载 CSV 并归档到 `<账单根目录>/<店铺>/<期间>/<店铺>-订单-<月>月.csv`，同时生成 `订单信息.md`。

- 自动找店（profileName → 店铺名，错误映射自动修正）
- 日期：整月/跨月/任意起止日；结束日 +1 天（00:00 不含当天）
- 导出：对账报表（订单/商品/金额字段），UTF-8 BOM CSV
- 归档：`订单信息.md` 含单量/实付/实收/状态分布/SHA-256

## 安装

复制/联接到 `~/.agents/skills/pdd-order-export`：

```bash
mkdir -p ~/.agents/skills
cp -r . ~/.agents/skills/pdd-order-export
```

> Windows：`mklink /J C:\Users\<你>\.agents\skills\pdd-order-export <本仓库路径>`

## 前置条件

- Windows + ego-browser（各店 profile 已登录）
- Node.js
- 账单根目录（默认 `D:/对账账单`，非 C 盘；`root` 可改）

## 用法

```bash
node run.mjs order-config.json
```

```json
{
  "from": "2026-10-01",
  "to": "2026-10-31",
  "root": "D:/对账账单",
  "shops": [{ "shop": "<店铺A>", "profile": "<profile-A>" }]
}
```

也支持只给 `from/to`，从 `<root>/_stores.json` 读店铺。默认串行（下载目录共享）。

自检（只读，不导出）：

```json
{ "doctor": true, "from": "2026-10-01", "to": "2026-10-31" }
```

示例：`examples/order-config.example.json`、`examples/doctor-config.example.json`。

可选：`waitCooldown`（默认 true）、`cooldownSec`（默认 300）、`refreshStores`、`keepOpen`。

## 输出

```
<root>/<店铺>/<期间>/
├─ <店铺>-订单-<月>月.csv
└─ 订单信息.md
```

详细规则见 [SKILL.md](SKILL.md)；页面契约/实现/测试/踩坑见 [references/](references/)。
