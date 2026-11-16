import type { Line, TaxMethod } from '@/lib/calc';

export type BoqStatus = 'draft' | 'in_review' | 'approved' | 'sent' | 'accepted' | 'rejected' | 'superseded';
export type OfferCurrency = 'BDT' | 'USD';
export type ExportChoice = 'BDT' | 'USD' | 'BOTH';

export interface BrandDTO {
  id: number;
  code: string;
  name: string;
  fullName: string;
  typeLines: string[];
  priceListName: string | null;
}

/** BOQ-level settings the editor changes. Numbers travel as strings so nothing is lost to floats. */
export interface BoqSettings {
  title: string;
  selectedBrandId: number;
  exchangeRate: string;
  impProfitPct: string;
  impDiscountPct: string;
  locProfitPct: string;
  locDiscountPct: string;
  aitPct: string;
  vatPct: string;
  taxMethod: TaxMethod;
  taxBaseA: boolean;
  taxBaseB: boolean;
  taxBaseC: boolean;
  addTaxToTotal: boolean;
  offerCurrency: OfferCurrency;
  offerNote: string;
}

/** One BOQ line. A saved line has itemId; a catalogue line not yet in the BOQ has itemId = null. */
export interface BoqRow {
  key: string;
  itemId: string | null;
  productId: string | null;
  priceListId: string | null;
  line: Line;
  brandId: number | null;
  isCustom: boolean;
  isEdited: boolean;
  groupName: string;
  groupLines: string[];
  typeName: string | null;
  typeLines: string[];
  description: string;
  model: string | null;
  unit: string;
  specs: string[];
  cost: string | null;
  qty: string;
  qtyFollowsLinks: boolean;
  linkSources: string[];
  profitPct: string | null;
  discountPct: string | null;
  defaultProfitZero: boolean;
  sortOrder: number;
}

/** A product from an active price list, as it is in the catalogue (used for "Restore original"). */
export interface CatalogEntry {
  productId: string;
  priceListId: string;
  kind: 'imported' | 'local';
  brandId: number | null;
  code: string | null;
  groupName: string;
  groupLines: string[];
  typeName: string | null;
  typeLines: string[];
  description: string;
  model: string | null;
  unit: string;
  specs: string[];
  cost: string | null;
  defaultProfitZero: boolean;
  sortOrder: number;
  linkSources: string[];
}

export interface BoqHeader {
  id: string;
  boqNo: string;
  revision: number;
  latestRevision: number;
  status: BoqStatus;
  version: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  siteAddress: string | null;
  clientId: string | null;
  clientName: string | null;
  clientEmail: string | null;
  ownerId: string | null;
  ownerName: string | null;
  sentAt: string | null;
  updatedAt: string;
}

export interface EditorPermissions {
  canEdit: boolean;
  canSeeCost: boolean;
  canGiveDiscount: boolean;
  canExport: boolean;
  canExportCosting: boolean;
  canSend: boolean;
  canRevise: boolean;
  readOnlyReason: string | null;
}

export interface EditorData {
  header: BoqHeader;
  settings: BoqSettings;
  rows: BoqRow[];
  catalog: CatalogEntry[];
  brands: BrandDTO[];
  perms: EditorPermissions;
}
