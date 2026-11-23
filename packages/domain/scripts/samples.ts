/** Sample rows for /contracts/samples. Invented data, realistic shape. */
import type { LogoFileType, LogoRowInput } from '../src/logo-contract';
import { gs1CheckDigit } from '../src/scan';

export const SAMPLE_DATE = '2026-11-23';

const gtin13 = (body12: string) => body12 + gs1CheckDigit(body12);

const ITEMS = [
  { code: 'DYS-PU-BEYAZ-600ML', name: 'Dayson PU Mastik Beyaz 600 ml Sosis', unit: 'ADET', gtin: gtin13('869123450001'), cost: '2.84' },
  { code: 'DYS-PU-GRI-600ML', name: 'Dayson PU Mastik Gri 600 ml Sosis', unit: 'ADET', gtin: gtin13('869123450002'), cost: '2.84' },
  { code: 'DYS-PU-SIYAH-310ML', name: 'Dayson PU Mastik Siyah 310 ml Kartuş', unit: 'ADET', gtin: gtin13('869123450003'), cost: '1.92' },
  { code: 'DYS-SLK-SEFFAF-280ML', name: 'Dayson Silikon Şeffaf 280 ml Kartuş', unit: 'ADET', gtin: gtin13('869123450010'), cost: '1.15' },
  { code: 'DYS-MB-GRI-48MM', name: 'Dayson Maskeleme Bandı Gri 48 mm x 40 m', unit: 'RULO', gtin: gtin13('869123450020'), cost: '0.96' },
  { code: 'DYS-MB-SARI-24MM', name: 'Dayson Maskeleme Bandı Sarı 24 mm x 40 m', unit: 'RULO', gtin: gtin13('869123450021'), cost: '0.52' },
  { code: 'SIA-DISK-150-15D-P240', name: 'SIA Zımpara Diski 150 mm 15 Delik P240', unit: 'KUTU', gtin: '', cost: '14.60' },
  { code: 'SIA-DISK-150-15D-P320', name: 'SIA Zımpara Diski 150 mm 15 Delik P320', unit: 'KUTU', gtin: '', cost: '14.60' },
];

export const SAMPLE_ROWS: Record<LogoFileType, LogoRowInput[]> = {
  items: ITEMS.map((i, idx) => ({ logo_item_code: i.code, name: i.name, unit: i.unit, gtin: i.gtin, active: idx !== 5 })),
  parties: [
    { logo_cari_code: '120.34.0017', name: 'Yıldız Oto Boya San. ve Tic. Ltd. Şti.', vkn: '9876543210', type: 'dealer', city: 'İstanbul', country: 'TR', active: true },
    { logo_cari_code: '120.06.0042', name: 'Çankaya Yapı Malzemeleri A.Ş.', vkn: '1234567890', type: 'dealer', city: 'Ankara', country: 'TR', active: true },
    { logo_cari_code: '120.35.0008', name: 'Ege Hırdavat; Boya ve Nalbur', vkn: '5556667778', type: 'dealer', city: 'İzmir', country: 'TR', active: true },
    { logo_cari_code: '120.99.0103', name: 'Balkan Coatings DOOEL', vkn: '', type: 'importer', city: 'Skopje', country: 'MK', active: true },
    { logo_cari_code: '320.01.0005', name: 'sia Abrasives Industries AG', vkn: '', type: 'supplier', city: 'Frauenfeld', country: 'CH', active: true },
    { logo_cari_code: '320.41.0011', name: 'Kocaeli Ambalaj San. A.Ş.', vkn: '4443332221', type: 'supplier', city: 'Kocaeli', country: 'TR', active: false },
  ],
  sales_docs: [
    { doc_type: 'irsaliye', doc_no: 'IRS2026000481', doc_date: '2026-11-20', logo_cari_code: '120.34.0017', logo_item_code: 'DYS-PU-BEYAZ-600ML', qty: 2400, unit: 'ADET', unit_price_eur: '3.650', is_free: false, e_irsaliye_no: 'DYS2026000000481', ref_shipment_id: 'SHP-2026-000312' },
    { doc_type: 'irsaliye', doc_no: 'IRS2026000481', doc_date: '2026-11-20', logo_cari_code: '120.34.0017', logo_item_code: 'DYS-PU-BEYAZ-600ML', qty: 240, unit: 'ADET', unit_price_eur: '0', is_free: true, e_irsaliye_no: 'DYS2026000000481', ref_shipment_id: 'SHP-2026-000312' },
    { doc_type: 'irsaliye', doc_no: 'IRS2026000481', doc_date: '2026-11-20', logo_cari_code: '120.34.0017', logo_item_code: 'DYS-MB-GRI-48MM', qty: 720, unit: 'RULO', unit_price_eur: '1.280', is_free: false, e_irsaliye_no: 'DYS2026000000481', ref_shipment_id: 'SHP-2026-000312' },
    { doc_type: 'invoice', doc_no: 'FTR2026000455', doc_date: '2026-11-21', logo_cari_code: '120.34.0017', logo_item_code: 'DYS-PU-BEYAZ-600ML', qty: 2400, unit: 'ADET', unit_price_eur: '3.650', is_free: false, e_irsaliye_no: 'DYS2026000000481', ref_shipment_id: 'SHP-2026-000312' },
    { doc_type: 'irsaliye', doc_no: 'IRS2026000482', doc_date: '2026-11-21', logo_cari_code: '120.06.0042', logo_item_code: 'SIA-DISK-150-15D-P240', qty: 60, unit: 'KUTU', unit_price_eur: '21.900', is_free: false, e_irsaliye_no: 'DYS2026000000482', ref_shipment_id: 'SHP-2026-000313' },
    { doc_type: 'irsaliye', doc_no: 'IRS2026000483', doc_date: '2026-11-22', logo_cari_code: '120.35.0008', logo_item_code: 'DYS-SLK-SEFFAF-280ML', qty: 1200, unit: 'ADET', unit_price_eur: '', is_free: false, e_irsaliye_no: '', ref_shipment_id: '' },
  ],
  purchase_docs: [
    { doc_no: 'ALM2026000097', doc_date: '2026-11-18', logo_cari_code: '320.01.0005', logo_item_code: 'SIA-DISK-150-15D-P240', qty: 400, unit: 'KUTU' },
    { doc_no: 'ALM2026000097', doc_date: '2026-11-18', logo_cari_code: '320.01.0005', logo_item_code: 'SIA-DISK-150-15D-P320', qty: 250, unit: 'KUTU' },
    { doc_no: 'ALM2026000098', doc_date: '2026-11-19', logo_cari_code: '320.41.0011', logo_item_code: 'DYS-MB-SARI-24MM', qty: 4320, unit: 'RULO' },
  ],
  stock_snapshot: ITEMS.slice(0, 7).map((i, idx) => ({
    as_of: '2026-11-22T21:00:00+03:00',
    logo_item_code: i.code,
    warehouse_code: 'TUZLA',
    qty: [38400, 21600, 9120, 15360.5, 11520, 0, 842][idx],
    unit: i.unit,
  })),
  item_cost: ITEMS.map((i) => ({ logo_item_code: i.code, cost_eur: i.cost, as_of: '2026-11-01' })),
  shipment_confirm: [
    { shipment_id: 'SHP-2026-000312', ship_date: '2026-11-20', logo_cari_code: '120.34.0017', logo_item_code: 'DYS-PU-BEYAZ-600ML', qty: 2400, unit: 'ADET', lot_no: 'L26K1403', line_type: 'paid', campaign_code: 'KASIM-10+1' },
    { shipment_id: 'SHP-2026-000312', ship_date: '2026-11-20', logo_cari_code: '120.34.0017', logo_item_code: 'DYS-PU-BEYAZ-600ML', qty: 240, unit: 'ADET', lot_no: 'L26K1403', line_type: 'free', campaign_code: 'KASIM-10+1' },
    { shipment_id: 'SHP-2026-000312', ship_date: '2026-11-20', logo_cari_code: '120.34.0017', logo_item_code: 'DYS-MB-GRI-48MM', qty: 720, unit: 'RULO', lot_no: 'L26J0907', line_type: 'paid', campaign_code: '' },
    { shipment_id: 'SHP-2026-000313', ship_date: '2026-11-21', logo_cari_code: '120.06.0042', logo_item_code: 'SIA-DISK-150-15D-P240', qty: 60, unit: 'KUTU', lot_no: 'SIA-88213', line_type: 'paid', campaign_code: '' },
  ],
  receipts: [
    { receipt_id: 'RCP-2026-000140', date: '2026-11-18', supplier_code: '320.01.0005', logo_item_code: 'SIA-DISK-150-15D-P240', qty: 400, lot_no: 'SIA-88213' },
    { receipt_id: 'RCP-2026-000140', date: '2026-11-18', supplier_code: '320.01.0005', logo_item_code: 'SIA-DISK-150-15D-P320', qty: 250, lot_no: 'SIA-88240' },
    { receipt_id: 'RCP-2026-000141', date: '2026-11-19', supplier_code: 'URETIM', logo_item_code: 'DYS-PU-GRI-600ML', qty: 7200, lot_no: 'L26K1901' },
  ],
  adjustments: [
    { txn_id: '6f1c2a9e-5b7d-4c11-9f0e-2d3a4b5c6d7e', date: '2026-11-21', logo_item_code: 'DYS-MB-GRI-48MM', qty_signed: -36, reason_code: 'COUNT_VARIANCE', approved_by: '' },
    { txn_id: '0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d', date: '2026-11-21', logo_item_code: 'DYS-PU-SIYAH-310ML', qty_signed: -480, reason_code: 'SCRAP_EXPIRED', approved_by: 'ayse.demir' },
    { txn_id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', date: '2026-11-22', logo_item_code: 'SIA-DISK-150-15D-P320', qty_signed: 2, reason_code: 'COUNT_VARIANCE', approved_by: '' },
  ],
  consignment_sales: [
    { dealer_code: '120.06.0042', logo_item_code: 'DYS-PU-BEYAZ-600ML', qty: 480, period: '2026-10' },
    { dealer_code: '120.06.0042', logo_item_code: 'DYS-SLK-SEFFAF-280ML', qty: 300, period: '2026-10' },
    { dealer_code: '120.35.0008', logo_item_code: 'DYS-MB-GRI-48MM', qty: 144, period: '2026-10' },
  ],
  campaign_settlement: [
    { campaign_code: 'Q3-HEDEF-PRIM', dealer_code: '120.34.0017', type: 'rebate', amount_eur: '1845.50', qty: '' },
    { campaign_code: 'Q3-HEDEF-PRIM', dealer_code: '120.06.0042', type: 'rebate', amount_eur: '920.00', qty: '' },
    { campaign_code: 'KASIM-10+1', dealer_code: '120.34.0017', type: 'free_goods_total', amount_eur: '', qty: 240 },
  ],
};
