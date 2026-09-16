export const BASE_CURRENCY = 'JPY';
export const MARKET_CODES = ['TW', 'SG', 'MY', 'TH', 'PH', 'VN', 'BR'];
export const FX_CURRENCIES = ['TWD', 'SGD', 'MYR', 'THB', 'PHP', 'VND', 'BRL'];

export const MARKETS = {
  TW: { nameKo: '대만', currency: 'TWD', active: true },
  SG: { nameKo: '싱가포르', currency: 'SGD', active: true },
  MY: { nameKo: '말레이시아', currency: 'MYR', active: true },
  TH: { nameKo: '태국', currency: 'THB', active: true },
  PH: { nameKo: '필리핀', currency: 'PHP', active: true },
  VN: { nameKo: '베트남', currency: 'VND', active: true },
  BR: { nameKo: '브라질', currency: 'BRL', active: false, futureMarket: true }
};

export const ORDER_STATUS_KO = {
  UNPAID: '결제 대기',
  READY_TO_SHIP: '배송 준비 중',
  PROCESSED: '출고 처리됨',
  SHIPPED: '배송 중',
  TO_CONFIRM_RECEIVE: '수령 확인 대기',
  COMPLETED: '완료',
  IN_CANCEL: '취소 처리 중',
  CANCELLED: '취소'
};

export function orderStatusKo(status) {
  return ORDER_STATUS_KO[status] || status || '상태 없음';
}
