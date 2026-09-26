/**
 * Approved business read operations.
 *
 * The AI service may call only these functions. There is no SQL access.
 * To connect a real system later, implement BusinessDataProvider against
 * the company or SAP API and change the export at the bottom of this file.
 * ai.service.ts depends on the interface, not on the mock data.
 */

export interface PendingOrdersResult {
  source: "mock";
  pendingOrders: number;
}

export interface PendingQuotationsResult {
  source: "mock";
  pendingQuotations: number;
}

export interface LowStockProduct {
  sku: string;
  name: string;
  quantityOnHand: number;
  reorderLevel: number;
}

export interface LowStockResult {
  source: "mock";
  lowStockProducts: number;
  products: LowStockProduct[];
}

export interface BusinessDataProvider {
  getPendingOrders(): Promise<PendingOrdersResult>;
  getPendingQuotations(): Promise<PendingQuotationsResult>;
  getLowStockProducts(): Promise<LowStockResult>;
}

const SAMPLE_BUSINESS_DATA = {
  pendingOrders: 5,
  pendingQuotations: 8,
  lowStockProducts: [
    { sku: "SKU-1042", name: "Industrial Sensor", quantityOnHand: 2, reorderLevel: 10 },
    { sku: "SKU-2201", name: "Hydraulic Valve", quantityOnHand: 1, reorderLevel: 8 },
    { sku: "SKU-3310", name: "Control Relay", quantityOnHand: 4, reorderLevel: 12 },
  ],
};

export class MockBusinessService implements BusinessDataProvider {
  async getPendingOrders(): Promise<PendingOrdersResult> {
    return {
      source: "mock",
      pendingOrders: SAMPLE_BUSINESS_DATA.pendingOrders,
    };
  }

  async getPendingQuotations(): Promise<PendingQuotationsResult> {
    return {
      source: "mock",
      pendingQuotations: SAMPLE_BUSINESS_DATA.pendingQuotations,
    };
  }

  async getLowStockProducts(): Promise<LowStockResult> {
    return {
      source: "mock",
      lowStockProducts: SAMPLE_BUSINESS_DATA.lowStockProducts.length,
      products: SAMPLE_BUSINESS_DATA.lowStockProducts.map((product) => ({ ...product })),
    };
  }
}

/**
 * Active provider. Swap this for a SAP or company API implementation:
 *
 * class SapBusinessService implements BusinessDataProvider { ... }
 * export const businessService: BusinessDataProvider = new SapBusinessService();
 */
export const businessService: BusinessDataProvider = new MockBusinessService();
