# HeroSMS API 文档

> API protocol for working with HEROSMS
> Version: v1.0 | OAS 3.1.0
> 来源: https://hero-sms.com/cn/api

## 概述

HeroSMS 兼容 SMS-Activate 合作伙伴协议。如果你使用的软件支持 SMS-Activate，只需：

1. 选择任何包含 SMS-Activate 的短信接收服务的软件
2. 选择 SMS-Activate 作为接收短信的服务
3. 将软件设置中的 host 从 `https://api.sms-activate.ae` 替换为 `https://hero-sms.com`
4. 输入你 HeroSMS 账户的 API key（在网站上申请）

## 服务器地址

```
https://hero-sms.com/stubs/handler_api.php
```

## 认证

所有请求需要通过 `api_key` 查询参数传递 API Key。

---

## API 接口列表

### 1. 查询账户余额 (getBalance)

**请求方式:** `GET`

```
GET /stubs/handler_api.php?action=getBalance&api_key=YOUR_SECRET_TOKEN
```

**说明:** 返回当前余额，格式为 `ACCESS_BALANCE:<amount>`

**请求示例:**
```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=getBalance&api_key=YOUR_SECRET_TOKEN'
```

**响应示例 (200):**
```
ACCESS_BALANCE:100.5
```

**错误码:**
| 状态码 | 说明 |
|--------|------|
| 401 | 无效的 API key |
| 404 | 方法未找到 |
| 422 | 无效的请求参数 |
| 500 | 内部服务错误 |

---

### 2. 请求号码 (getNumber)

**请求方式:** `GET`

```
GET /stubs/handler_api.php?action=getNumber&service={service}&country={country}&api_key=YOUR_SECRET_TOKEN
```

**说明:** 请求指定服务和国家的电话号码。返回格式 `ACCESS_NUMBER:<activation_id>:<number>`

**查询参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| service | string | 是 | 服务 ID（如 `tg`） |
| country | number | 是 | 国家 ID |
| operator | string | 否 | 运营商列表（逗号分隔，无空格） |
| maxPrice | number | 否 | 最大价格 |
| fixedPrice | string | 否 | 严格按 maxPrice 购买，需与 maxPrice 配合使用 |
| ref | string | 否 | 推荐标识 |
| phoneException | string | 否 | 排除前缀，最多 20 个 |

**请求示例:**
```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=getNumber&service=tg&country=2&api_key=YOUR_SECRET_TOKEN'
```

**响应示例 (200):**
```
ACCESS_NUMBER:123456789:7*********0
```

**错误码:**
| 状态码 | 说明 |
|--------|------|
| 400 | 无效的请求参数 |
| 401 | 无效的 API key |
| 402 | 余额不足 |
| 403 | 访问被拒绝 |
| 404 | 方法未找到 |
| 422 | 无效的请求参数 |
| 500 | 内部服务错误 |

---

### 3. 请求号码 V2 (getNumberV2)

**请求方式:** `GET`

```
GET /stubs/handler_api.php?action=getNumberV2&service={service}&country={country}&api_key=YOUR_SECRET_TOKEN
```

**说明:** 与 getNumber 类似，但返回更多激活信息（JSON 对象）

**查询参数:** 与 getNumber 相同

**请求示例:**
```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=getNumberV2&service=tg&country=2&api_key=YOUR_SECRET_TOKEN'
```

**响应示例 (200):**
```json
{
  "activationId": "635468024",
  "phoneNumber": "79584******",
  "activationCost": 12.5,
  "currency": 840,
  "countryCode": 6,
  "countryPhoneCode": 62,
  "canGetAnotherSms": true,
  "activationTime": "2026-02-18T16:11:33+00:00",
  "activationEndTime": "2026-02-18T18:11:23+00:00",
  "activationOperator": "any"
}
```

**错误码:** 同 getNumber

---

### 4. 修改激活状态 (setStatus)

**请求方式:** `GET`

```
GET /stubs/handler_api.php?action=setStatus&id={id}&status={status}&api_key=YOUR_SECRET_TOKEN
```

**说明:** 激活生命周期管理。可用状态值：
- `1` — 短信已发送
- `3` — 请求重新发送短信
- `6` — 完成激活（验证码已收到并确认）
- `8` — 取消激活（退款）

**查询参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | integer | 是 | 激活 ID |
| status | number | 是 | 激活状态（1/3/6/8） |

**请求示例:**
```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=setStatus&id=123456789&status=1&api_key=YOUR_SECRET_TOKEN'
```

**响应示例 (200):**
```
ACCESS_RETRY_GET
```

**错误码:**
| 状态码 | 说明 |
|--------|------|
| 400 | 无效的请求参数 |
| 401 | 无效的 API key |
| 403 | 访问被拒绝 |
| 404 | 激活未找到 |
| 409 | 无法取消激活 |
| 422 | 无效的请求参数 |
| 500 | 内部服务错误 |

---

### 5. 获取激活状态 (getStatus)

**请求方式:** `GET`

```
GET /stubs/handler_api.php?action=getStatus&id={id}&api_key=YOUR_SECRET_TOKEN
```

**说明:** 返回当前激活状态（文本形式）+ 可用时返回验证码。
状态值：`STATUS_WAIT_CODE`、`STATUS_OK` 等

**查询参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | integer | 是 | 激活 ID |

**请求示例:**
```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=getStatus&id=123456789&api_key=YOUR_SECRET_TOKEN'
```

**响应示例 (200):**
```
STATUS_WAIT_CODE
```

**错误码:**
| 状态码 | 说明 |
|--------|------|
| 400 | 无效的请求参数 |
| 401 | 无效的 API key |
| 402 | 余额不足 |
| 403 | 访问被拒绝 |
| 404 | 激活未找到 |
| 422 | 无效的请求参数 |
| 500 | 内部服务错误 |

---

### 6. 获取激活状态 V2 (getStatusV2)

**请求方式:** `GET`

```
GET /stubs/handler_api.php?action=getStatusV2&id={id}&api_key=YOUR_SECRET_TOKEN
```

**说明:** 返回结构化的激活状态（JSON 格式）

**查询参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | integer | 是 | 激活 ID |

**请求示例:**
```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=getStatusV2&id=123456789&api_key=YOUR_SECRET_TOKEN'
```

**响应示例 (200):**
```json
{
  "verificationType": 2,
  "sms": {
    "dateTime": "0000-00-00 00:00:00",
    "code": "code",
    "text": "sms text"
  },
  "call": {
    "from": "phone",
    "text": "voice text",
    "code": "12345",
    "dateTime": "0000-00-00 00:00:00",
    "url": "voice file url",
    "parsingCount": 1
  }
}
```

**错误码:** 同 getStatus

---

### 7. 获取活跃激活列表 (getActiveActivations)

**请求方式:** `GET`

```
GET /stubs/handler_api.php?action=getActiveActivations&api_key=YOUR_SECRET_TOKEN
```

**说明:** 返回活跃的激活列表

**查询参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| start | integer | 否 | 偏移量（默认 0） |
| limit | integer | 否 | 条目限制（最多 100） |

**请求示例:**
```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=getActiveActivations&api_key=YOUR_SECRET_TOKEN'
```

**响应示例 (200):**
```json
{
  "status": "success",
  "data": [
    {
      "activationId": "635468021",
      "serviceCode": "vk",
      "phoneNumber": "79********1",
      "activationCost": 12.5,
      "activationStatus": "4",
      "smsCode": "12345",
      "smsText": "Your code is 12345",
      "activationTime": "2022-06-01 16:59:16",
      "discount": "0.00",
      "repeated": "0",
      "countryCode": "2",
      "countryName": "Kazakhstan",
      "canGetAnotherSms": "1",
      "currency": 840
    }
  ]
}
```

**错误码:**
| 状态码 | 说明 |
|--------|------|
| 400 | 无效的请求参数 |
| 401 | 无效的 API key |
| 402 | 余额不足 |
| 403 | 访问被拒绝 |
| 404 | 方法未找到 |
| 422 | 无效的请求参数 |
| 500 | 内部服务错误 |

---

### 8. 获取激活历史 (getHistory)

**请求方式:** `GET`

```
GET /stubs/handler_api.php?action=getHistory&api_key=YOUR_SECRET_TOKEN
```

**说明:** 返回激活历史

**查询参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| start | integer | 否 | 开始时间（Unix 时间戳） |
| end | integer | 否 | 结束时间（Unix 时间戳） |
| offset | integer | 否 | 偏移量（默认 0） |
| size | integer | 否 | 条目限制（最多 100） |

**请求示例:**
```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=getHistory&api_key=YOUR_SECRET_TOKEN'
```

**响应示例 (200):**
```json
[
  {
    "id": "635468024",
    "date": "0000-00-00 00:00:00",
    "phone": "7*********0",
    "sms": "Your code is ****",
    "cost": 0,
    "status": "4",
    "currency": 840
  }
]
```

**错误码:**
| 状态码 | 说明 |
|--------|------|
| 401 | 无效的 API key |
| 404 | 方法未找到 |
| 422 | 无效的请求参数 |
| 500 | 内部服务错误 |

---

### 9. 请求号码重新激活 (reactivate)

**请求方式:** `GET`

```
GET /stubs/handler_api.php?action=reactivate&id={id}&api_key=YOUR_SECRET_TOKEN
```

**说明:** 请求重新使用已成功使用过的电话号码

**查询参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | integer | 是 | 激活 ID |

**请求示例:**
```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=reactivate&id=123456789&api_key=YOUR_SECRET_TOKEN'
```

**响应示例 (200):**
```json
{
  "activationId": "123456",
  "phoneNumber": "79991234567",
  "activationCost": 15.5,
  "currency": 840,
  "countryCode": 2,
  "countryPhoneCode": 62,
  "canGetAnotherSms": true,
  "activationTime": "2026-02-19T10:37:46+00:00",
  "activationEndTime": "2026-02-19T10:37:46+00:00",
  "activationOperator": "tele2"
}
```

**错误码:**
| 状态码 | 说明 |
|--------|------|
| 401 | 无效的 API key |
| 402 | 余额不足 |
| 403 | 访问被拒绝 |
| 404 | 激活未找到 |
| 500 | 内部服务错误 |

---

### 10. 请求号码重新激活费用 (reactivationPrice)

**请求方式:** `GET`

```
GET /stubs/handler_api.php?action=reactivationPrice&id={id}&api_key=YOUR_SECRET_TOKEN
```

**说明:** 请求号码重新激活的费用

**查询参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | integer | 是 | 激活 ID |

**请求示例:**
```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=reactivationPrice&id=123456789&api_key=YOUR_SECRET_TOKEN'
```

**响应示例 (200):**
```json
{
  "data": {
    "price": 1.4522,
    "currency": 840
  }
}
```

**错误码:**
| 状态码 | 说明 |
|--------|------|
| 401 | 无效的 API key |
| 402 | 余额不足 |
| 403 | 访问被拒绝 |
| 404 | 激活未找到 |
| 500 | 内部服务错误 |

---

### 11. 获取国家列表 (getCountries)

**请求方式:** `GET`

```
GET /stubs/handler_api.php?action=getCountries&api_key=YOUR_SECRET_TOKEN
```

**说明:** 返回国家列表

**请求示例:**
```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=getCountries&api_key=YOUR_SECRET_TOKEN'
```

**响应示例 (200):**
```json
[
  {
    "id": 2,
    "rus": "Казахстан",
    "eng": "Kazakhstan",
    "chn": "哈萨克斯坦",
    "visible": 1,
    "retry": 1
  }
]
```

---

### 12. 获取服务列表 (getServicesList)

**请求方式:** `GET`

```
GET /stubs/handler_api.php?action=getServicesList&api_key=YOUR_SECRET_TOKEN
```

**说明:** 返回服务列表

**查询参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| country | number | 否 | 国家 ID |
| lang | string | 否 | 语言 ID（`en`/`cn`/`es`/`pt`/`de`） |

**请求示例:**
```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=getServicesList&api_key=YOUR_SECRET_TOKEN'
```

**响应示例 (200):**
```json
{
  "status": "success",
  "services": [
    {
      "code": "aoo",
      "name": "Pegasus Airlines"
    }
  ]
}
```

---

### 13. 获取可用运营商 (getOperators)

**请求方式:** `GET`

```
GET /stubs/handler_api.php?action=getOperators&api_key=YOUR_SECRET_TOKEN
```

**说明:** 返回运营商列表

**查询参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| country | number | 否 | 国家 ID |

**请求示例:**
```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=getOperators&api_key=YOUR_SECRET_TOKEN'
```

**响应示例 (200):**
```json
{
  "status": "success",
  "countryOperators": {
    "175": ["optus", "vodafone", "telstra", "lebara"]
  }
}
```

---

### 14. 获取当前价格 (getPrices)

**请求方式:** `GET`

```
GET /stubs/handler_api.php?action=getPrices&api_key=YOUR_SECRET_TOKEN
```

**说明:** 返回按国家和服务分类的价格和可用号码数量

**查询参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| service | string | 否 | 服务 ID |
| country | number | 否 | 国家 ID |

**请求示例:**
```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=getPrices&api_key=YOUR_SECRET_TOKEN'
```

**响应示例 (200):**
```json
[
  {
    "baa": {
      "cost": 0.08,
      "count": 25370,
      "physicalCount": 14528
    }
  }
]
```

---

### 15. 按服务获取热门国家 (getTopCountriesByService)

**请求方式:** `GET`

```
GET /stubs/handler_api.php?action=getTopCountriesByService&api_key=YOUR_SECRET_TOKEN
```

**说明:** 返回按服务分类的热门国家及可用号码数量。未指定服务时返回所有服务的热门国家。

**查询参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| service | string | 否 | 服务 ID |
| freePrice | boolean | 否 | 使用 FreePrice |

**请求示例:**
```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=getTopCountriesByService&api_key=YOUR_SECRET_TOKEN'
```

**响应示例 (200):**
```json
[
  {
    "ig": [
      {
        "physicalTotalCount": 7933,
        "physicalCountForDefaultPrice": 5198,
        "physicalPriceMap": {
          "0.04": 24,
          "0.0415": 439,
          "0.0419": 3229
        },
        "retail_price": 0.2,
        "country": 6,
        "price": 0.045,
        "count": 5477
      }
    ]
  }
]
```

---

### 16. 按用户等级获取热门国家 (getTopCountriesByServiceRank)

**请求方式:** `GET`

```
GET /stubs/handler_api.php?action=getTopCountriesByServiceRank&api_key=YOUR_SECRET_TOKEN
```

**说明:** 返回按服务分类的热门国家（考虑用户等级）

**查询参数:** 同 getTopCountriesByService

**请求示例:**
```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=getTopCountriesByServiceRank&api_key=YOUR_SECRET_TOKEN'
```

**响应示例:** 同 getTopCountriesByService

---

### 17. 获取租赁价格和数量 (serviceCountRent)

**请求方式:** `GET`

```
GET /stubs/handler_api.php?action=serviceCountRent&service={service}&api_key=YOUR_SECRET_TOKEN
```

**说明:** 返回指定服务的租赁价格和可用号码数量

**查询参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| service | string | 是 | 服务 ID |
| country | number | 否 | 国家 ID |
| operator | string | 否 | 运营商列表（逗号分隔） |
| currency | number | 否 | 显示货币（643/840/978/156） |

**请求示例:**
```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=serviceCountRent&service=tg&api_key=YOUR_SECRET_TOKEN'
```

**响应示例 (200):**
```json
{
  "6": {
    "2": {
      "price": 0.18,
      "count": 25370
    },
    "12": {
      "price": 0.4568,
      "count": 400
    },
    "48": {
      "price": 0.8575,
      "count": 4523
    }
  }
}
```

**错误码:**
| 状态码 | 说明 |
|--------|------|
| 400 | 无效的请求参数 |
| 401 | 无效的 API key |
| 500 | 内部服务错误 |

---

### 18. 租赁号码 (getRentNumber)

**请求方式:** `GET`

```
GET /stubs/handler_api.php?action=getRentNumber&service={service}&country={country}&duration={duration}&api_key=YOUR_SECRET_TOKEN
```

**说明:** 请求指定服务和国家的电话号码进行租赁

**查询参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| service | string | 是 | 服务 ID |
| country | number | 是 | 国家 ID |
| duration | number | 是 | 租赁时间（小时） |
| operator | string | 否 | 运营商列表（逗号分隔） |
| currency | number | 否 | 显示货币（643/840/978/156） |
| ref | string | 否 | 推荐标识 |

**请求示例:**
```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=getRentNumber&service=tg&country=2&duration=2&api_key=YOUR_SECRET_TOKEN'
```

**响应示例 (200):**
```json
{
  "activationId": "123456",
  "phoneNumber": "79991234567",
  "activationCost": 15.5,
  "currency": 840,
  "countryCode": 2,
  "countryPhoneCode": 62,
  "canGetAnotherSms": true,
  "activationTime": "2026-02-19T10:37:46+00:00",
  "activationEndTime": "2026-02-19T10:37:46+00:00",
  "activationOperator": "tele2"
}
```

**错误码:**
| 状态码 | 说明 |
|--------|------|
| 400 | 无效的请求参数 |
| 401 | 无效的 API key |
| 402 | 余额不足 |
| 403 | 访问被拒绝 |
| 404 | 无可售号码 |
| 500 | 内部服务错误 |

---

### 19. 获取指定激活的所有短信 (getAllSms)

**请求方式:** `GET`

```
GET /stubs/handler_api.php?action=getAllSms&id={id}&api_key=YOUR_SECRET_TOKEN
```

**说明:** 请求指定激活的所有短信

**查询参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | integer | 是 | 激活 ID |
| size | integer | 否 | 每页数据大小 |
| page | integer | 否 | 页码 |

**请求示例:**
```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=getAllSms&id=123456789&api_key=YOUR_SECRET_TOKEN'
```

**响应示例 (200):**
```json
{
  "data": [],
  "meta": {
    "total": 42,
    "service": "full"
  }
}
```

**错误码:**
| 状态码 | 说明 |
|--------|------|
| 400 | 无效的请求参数 |
| 401 | 无效的 API key |
| 403 | 访问被拒绝 |
| 404 | 激活未找到 |
| 409 | 激活不活跃，操作不可能 |
| 500 | 内部服务错误 |

---

### 20. 完成激活 (finishActivation)

**请求方式:** `GET`

```
GET /stubs/handler_api.php?action=finishActivation&id={id}&api_key=YOUR_SECRET_TOKEN
```

**查询参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | integer | 是 | 激活 ID |

**请求示例:**
```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=finishActivation&id=123456789&api_key=YOUR_SECRET_TOKEN'
```

**响应:** 204 No Body（成功）

**错误码:**
| 状态码 | 说明 |
|--------|------|
| 400 | 无效的请求参数 |
| 401 | 无效的 API key |
| 403 | 访问被拒绝 |
| 404 | 激活未找到 |
| 409 | 无法完成激活 |
| 500 | 内部服务错误 |

---

### 21. 取消激活购买 (cancelActivation)

**请求方式:** `GET`

```
GET /stubs/handler_api.php?action=cancelActivation&id={id}&api_key=YOUR_SECRET_TOKEN
```

**查询参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | integer | 是 | 激活 ID |

**请求示例:**
```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=cancelActivation&id=123456789&api_key=YOUR_SECRET_TOKEN'
```

**响应:** 204 No Body（成功）

**错误码:**
| 状态码 | 说明 |
|--------|------|
| 400 | 无效的请求参数 |
| 401 | 无效的 API key |
| 403 | 访问被拒绝 |
| 404 | 激活未找到 |
| 409 | 无法取消激活 |
| 500 | 内部服务错误 |

---

## Webhooks（实时事件通知）

购买号码后，无需反复请求激活状态来接收短信。服务会通过 POST 方法将短信内容发送到指定的 HTTPS URL。

### 配置说明

- 最多支持 **3 个** webhook URL
- URL 在账户个人信息中设置
- 每个 webhook 调用对每个 URL 独立执行

### 请求规范

| 属性 | 值 |
|------|-----|
| Method | POST |
| Content-Type | application/json |
| 响应超时 | 3 秒 |
| 重试次数 | 至少 7 次 |
| 重试间隔 | 20-30 秒 |
| 总重试时长 | 至少 3 分钟 |

> **强烈建议** 即使短信已在接收端处理，也应返回 200 状态码。

### Webhook 来源 IP 白名单

```
84.32.223.53
185.138.88.87
```

### Webhook: 收到短信 (sms-incoming)

**请求方式:** `POST`

**说明:** 当绑定到活跃激活的号码收到短信时触发

**请求体 (application/json):**
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| activationId | string (ActivationId) | 是 | 激活 ID |
| country | integer (CountryId, 0-999) | 是 | 国家 ID |
| receivedAt | string (dateISO8601, date-time) | 是 | 短信到达时间 |
| service | string (ServiceId, 2-4字符) | 是 | 服务代码 |
| text | string \| null (SMSText) | 是 | 短信文本 |
| code | string \| null (SMSCode) | 否 | 短信验证码 |

**请求体示例:**
```json
{
  "activationId": "123456",
  "service": "tg",
  "text": "Your code is 12345",
  "code": "12345",
  "country": 2,
  "receivedAt": "2025-12-16T10:30:00.000000Z"
}
```

**响应:**
- `200` — Webhook 成功接收（推荐响应）
- 其他 — Webhook 未被接受，将最多重试 7 次

---

## 数据模型 (Models)

| 模型名称 | 说明 |
|----------|------|
| CountryId | 国家 ID |
| CountryName | 国家名称 |
| ServiceId | 服务 ID（2-4 字符） |
| OperatorId | 运营商 ID |
| MaxPrice | 最大价格 |
| ActivationId | 激活 ID |
| Currency | 货币代码（643=RUB, 840=USD, 978=EUR, 156=CNY） |
| SMSText | 短信文本 |
| SMSCode | 短信验证码 |
| dateISO8601 | ISO 8601 日期格式 |
| dateRFC3339 | RFC 3339 日期格式 |
| ActivationStatusV2 | V2 激活状态对象 |
| ActiveActivation | 单个活跃激活 |
| ActiveActivations | 活跃激活列表 |
| ActivationsHistory | 激活历史 |
| TopCountriesOneService | 单服务热门国家 |
| TopCountriesAllServices | 所有服务热门国家 |
| TopCountriesByService | 按服务分类的热门国家 |
| PricesByCountry | 按国家分类的价格 |
| RentCountByService | 按服务分类的租赁数量 |
| Country | 国家对象 |
| Service | 服务对象 |
| Operators | 运营商对象 |
| AccountBannedInfo | 账户封禁信息 |
| successfulNumberv2Response | V2 号码请求成功响应 |
| reactivationPriceResponse | 重新激活价格响应 |
| OtpListResponse | OTP 列表响应 |
| OtpItem | OTP 项 |
| BaseErrorResponse | 基础错误响应 |
