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

## 3. 주요 메뉴

1. **상품 후보·등록 전 분석** — Shopee에 올리기 전 손익분기, 목표마진, 최대 매입가능가
2. **경쟁상품 조사** — 국가별 Shopee 경쟁가 수집, 중앙값 대표 경쟁가
3. **등록 직전 최종검사** — 제목/설명/SKU/가격/카테고리/필수속성/물류/이미지 검증
4. **운영 대시보드** — 매출, 주문, 실제 순이익, 발주 필요 SKU, 연결상태
5. **주문·출고·라벨** — 주문 상태, 배송 옵션, 출고 처리, Tracking Number, PDF 라벨
6. **재고·발주** — 일본 실물재고, 안전재고, 목표재고, 발주 필요수량, 입고, 재고원장
7. **상품·원가** — Shopee 상품 동기화, 일본 매입원가, 포장비, SKU 연결
8. **실제 수익** — Escrow/수수료/배송비/실제 순이익
9. **Shopee 연결 관리** — 국가별 Shop/Merchant 인증, 토큰 상태
10. **환율 관리** — 7개 통화 자동갱신, 상태, 수동갱신, 안전마진

## 4. 전체 구조

```text
브라우저(한글 UI)
       ↓
JAPANOVA Backend
       ├─ Shopee Open API V2
       ├─ 등록 전 손익/검증 엔진
       ├─ 환율 서비스
       ├─ 재고 원장/발주 엔진
       ├─ 수익 계산 엔진
       └─ PostgreSQL
```

### 보안 원칙

- `Partner Key`, `access_token`, `refresh_token`을 브라우저/GitHub Pages에 저장하지 않는다.
- HMAC-SHA256 서명은 서버에서만 생성한다.
- Production 토큰은 DB에 암호화하여 저장한다.
- 로그에는 토큰, Partner Key, Authorization Code를 남기지 않는다.
- 상품 생성/출고처럼 실제 상태를 바꾸는 API는 명시적 확인 없이 자동 실행하지 않는다.

## 5. Shopee 연동 검증 범위

Sandbox에서 아래 흐름을 검증했다.

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

배송라벨은 Open API 흐름을 연결했다.

```text
Tracking Number 조회
→ 배송라벨 형식 조회
→ 라벨 생성 요청
→ READY 상태 확인
→ PDF 다운로드
```

Production에서는 실제 6개국 Shop을 연결하고, 브라질은 입점 후 활성화한다.

## 6. 재고·발주 구조

재고는 현재고 숫자를 단순 덮어쓰지 않고 **원장(ledger)** 으로 관리한다.

주요 테이블:

- `inventory_items` — SKU별 안전재고, 목표재고, 매입처, 리드타임, 재고 추적 시작시점
- `inventory_movements` — 입고, 수동조정, 주문차감, 취소복구 이력

현재고:

```text
현재 실재고 = inventory_movements.quantity_delta 합계
```

자동 처리:

- 재고 추적 시작 이후 생성된 Shopee 주문만 자동 차감한다.
- `READY_TO_SHIP`, `PROCESSED`, `SHIPPED`, `TO_CONFIRM_RECEIVE`, `COMPLETED` 주문은 수량만큼 1회 차감한다.
- 같은 주문을 여러 번 동기화해도 `source_key`가 중복 차감을 막는다.
- `CANCELLED`가 되면 기존 차감분을 1회 자동 복구한다.
- 추적 시작 이전의 과거 주문은 소급 차감하지 않는다.

발주 기준:

```text
현재고 <= 안전재고
AND 목표재고 > 0
→ 발주 필요

발주 필요수량 = max(목표재고 - 현재고, 0)
```

입고 처리 시 수량을 재고원장에 더하고, 이번 매입단가를 입력하면 상품 매입원가에도 반영할 수 있다.

## 7. 환율 구조

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

## 8. 실제 순이익 기본 구조

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

## 9. 개발 단계

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

- 기존 V3.4 예상마진 엔진과 분리된 등록 전 수익성 엔진
- 실제 주문 정산과 원가 DB 연결
- 예상 vs 실제 순이익 비교

### Phase 4 — 운영

- 대시보드
- 주문 출고/라벨
- 일본 실물재고 원장
- 안전재고/목표재고/발주 큐
- 국가별 실적

### Phase 5 — 등록 전 자동화

- 상품 후보 DB
- 국가별 손익분기/목표마진/최대 매입가능가
- 경쟁상품 조사
- 국가별 판매대상 결정
- 등록 초안
- 카테고리/필수속성/물류 조회
- Shopee Media 이미지 업로드
- 서버 등록 직전 최종검사
- Sandbox 환경에서는 서버 최종검사 통과 후 `add_item`으로 UNLIST 테스트 상품 생성 가능
- Production `add_item`은 별도 안전스위치가 켜지기 전까지 계속 잠금

### Phase 6 — 확장

- 안전확인 후 상품등록/대량수정
- 캠페인 가격
- Winner SKU 분석
- 상품 발굴/시장분석 고도화
- 브라질 Production Shop 활성화

## 10. 현재 운영 흐름

### 상품 등록 전

```text
상품 발견
→ JAPANOVA 후보 등록
→ 일본 매입가/포장/중량 입력
→ 국가별 손익 시뮬레이션
→ 경쟁상품 조사
→ 최대 매입가능가/손익분기/목표마진 확인
→ 규제 확인
→ 판매국가 확정
→ 등록 초안
→ Shop/카테고리 선택
→ 필수속성 입력
→ 물류 채널 선택
→ Shopee Media 이미지 업로드
→ 서버 최종검사
→ Sandbox: 명시적 확인 후 UNLIST add_item 테스트
→ Production: 안전스위치 OFF 유지
```

### 상품 등록 후

```text
Shopee 상품
→ 일본 실물재고 설정/입고
→ 주문 동기화 및 자동 재고차감
→ 출고/배송라벨
→ Escrow 정산
→ 실제 순이익
→ 부족재고 발주
```

## 11. v1.3 등록 직전 최종검사 원칙

`v13.html`은 실제 상품 생성 전에 필요한 자료와 검증 상태를 관리한다.

- 카테고리 메타데이터 조회
- 카테고리 속성 폼 입력
- 필수속성 우선 표시
- 물류채널 조회/선택
- JPG/JPEG/PNG 이미지 파일을 명시적 클릭 시에만 Shopee Media에 업로드
- 업로드 결과 `image_id`를 국가별 등록 초안에 저장
- 브라우저 기본검사 후 서버가 DB 초안을 다시 읽어 Shopee 현재 메타데이터와 비교
- 서버 최종검사에서 차단 사유와 경고를 분리 표시
- Sandbox `add_item`은 명시적 확인문구 + 서버 안전스위치 + 중복등록 방지 원장을 모두 통과해야 실행
- Production `add_item`은 별도 안전스위치 없이는 실행 불가

v1.4에서는 Sandbox에 한해 최종검사 통과 후 UNLIST 테스트 상품을 명시적으로 생성할 수 있다. Production 자동등록은 계속 잠금 상태다.
