# JAPANOVA Seller OS

일본에서 상품을 소싱해 Shopee 7개국에 판매하는 JAPANOVA 전용 운영 시스템.

현재 루트 `index.html`의 V3.4 마진계산기는 안정 버전으로 유지하고, 새 시스템은 이 `seller-os/` 폴더에서 별도로 개발한다.

## 1. 지원 시장

- 대만 `TW / TWD`
- 싱가포르 `SG / SGD`
- 말레이시아 `MY / MYR`
- 태국 `TH / THB`
- 필리핀 `PH / PHP`
- 베트남 `VN / VND`
- 브라질 `BR / BRL` — 현재 미연동, 향후 활성화

시장 목록은 코드에 하드코딩하지 않고 설정/DB 기반으로 관리한다.

## 2. 사용자 화면 원칙

사용자에게 보이는 화면, 설명, 경고, 상태명은 한글 중심으로 표시한다. Shopee 원문 상태 코드는 문제 해결을 위해 보조표기로 함께 남긴다.

예:

- 배송 준비 중 `(READY_TO_SHIP)`
- 출고 처리됨 `(PROCESSED)`
- 배송 중 `(SHIPPED)`
- 완료 `(COMPLETED)`
- Shopee 정산액 `(escrow_amount_after_adjustment)`

내부 변수명과 API 필드명은 표준 영어를 유지한다.

## 3. 1차 메뉴

1. **대시보드** — 7개국 매출, 주문, 실제 순이익, 연결상태
2. **상품 관리** — Shopee 상품 동기화, 일본 매입원가, 포장비, SKU 연결
3. **주문 관리** — 주문/배송 상태, 국가별 필터, 주문 상세
4. **수익 분석** — Escrow/수수료/배송비/실제 순이익
5. **마진 계산기** — 판매 전 예상 판매가/마진, 기존 V3.4 엔진 이식
6. **Shopee 연결 관리** — 국가별 Shop/Merchant 인증, 토큰 상태
7. **환율 관리** — 7개 통화 자동갱신, 상태, 수동갱신, 안전마진

## 4. 전체 구조

```text
브라우저(한글 UI)
       ↓
JAPANOVA Backend
       ├─ Shopee Open API V2
       ├─ 환율 서비스
       ├─ 수익 계산 엔진
       └─ PostgreSQL
```

### 보안 원칙

- `Partner Key`, `access_token`, `refresh_token`을 브라우저/GitHub Pages에 저장하지 않는다.
- HMAC-SHA256 서명은 서버에서만 생성한다.
- Production 토큰은 DB에 암호화하여 저장한다.
- 로그에는 토큰, Partner Key, Authorization Code를 남기지 않는다.

## 5. Shopee 연동 검증 완료 범위

Sandbox에서 아래 흐름을 실제로 검증했다.

- Shop 정보 조회
- Product 목록 조회
- 테스트 상품 생성/게시
- 테스트 주문 생성
- Order List 조회
- Order Detail 조회
- Logistics 배송 파라미터 조회
- `ship_order` 출고 처리
- 주문 상태 `READY_TO_SHIP → PROCESSED`
- Pickup / Deliver 테스트
- Payment `get_escrow_detail`
- Income API 접근

Production에서는 실제 6개국 Shop을 연결하고, 브라질은 입점 후 활성화한다.

## 6. 환율 구조

기준통화는 JPY.

표시값:

- **기준 환율**: `1 현지통화 = ? JPY`
- **판매가 계산 환율**: `기준 환율 × (1 - 환율 안전마진)`
- 기본 환율 안전마진: `2%`

자동갱신:

- 매일 09:15 JST
- 1차: Frankfurter v2
- 독립 fallback: ExchangeRate-API Open
- 둘 다 실패하면 마지막 정상값 유지
- 두 소스 차이가 3% 초과하면 경고
- 직전 저장값 대비 5% 초과 변동 시 경고
- 주문마다 계산 당시 환율을 별도로 저장해 과거 순이익이 이후 환율 변경으로 바뀌지 않게 한다.

## 7. 실제 순이익 기본 구조

```text
Shopee 실제 정산액
- 일본 상품 매입원가
- 포장비
- 일본 국내배송 배분액
- Payoneer/송금비
- 기타 직접비
= JAPANOVA 실제 순이익
```

Shopee 정산은 한 필드만 보지 않고 주문별 Escrow 상세를 저장한다.

주요 필드:

- `order_selling_price`
- `buyer_paid_shipping_fee`
- `actual_shipping_fee`
- `final_shipping_fee`
- `shopee_shipping_rebate`
- `commission_fee`
- `seller_transaction_fee`
- `service_fee`
- `campaign_fee`
- `voucher_from_seller`
- `withholding_tax`
- `withholding_pit_tax`
- `escrow_amount`
- `escrow_amount_after_adjustment`

## 8. 개발 단계

### Phase 1 — 기반

- 7개국 설정
- DB 스키마
- 환율 서비스
- Shopee HMAC/API Client
- 연결상태 API

### Phase 2 — 동기화

- 상품 자동동기화
- 주문 자동동기화
- Escrow/정산 자동동기화
- refresh token 자동갱신

### Phase 3 — 수익

- 기존 V3.4 예상마진 엔진 이식
- 실제 주문 정산과 원가 DB 연결
- 예상 vs 실제 순이익 비교

### Phase 4 — 운영

- 대시보드
- Winner SKU 분석
- 국가별 실적
- 재고/가격 관리

### Phase 5 — 확장

- 상품등록/대량수정
- 캠페인 가격
- 상품 발굴/시장분석
- 브라질 Production Shop 활성화

## 9. 1차 목표

처음부터 모든 기능을 만들지 않는다.

```text
Shopee 연결상태
→ 상품 목록
→ 주문 목록
→ 주문 상세
→ 실제 정산
→ 실제 순이익
```

이 흐름이 Production에서 안정적으로 동작하는 것을 첫 번째 완성 기준으로 한다.
