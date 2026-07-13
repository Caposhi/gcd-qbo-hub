/**
 * Raw Tekmetric API response shapes — the subset of fields the normalizer
 * reads. These model Tekmetric's wire format (numeric ids, money in integer
 * CENTS, Spring-style pagination) and are consumed ONLY by
 * `src/lib/tekmetric/normalize.ts`. Nothing outside normalize.ts should import
 * from here — the rest of the hub consumes the normalized shapes in `types.ts`.
 *
 * Source: Tekmetric public API v1 docs (Repair Orders, Jobs, Vehicles,
 * Appointments, Employees). Money fields are documented by Tekmetric as
 * integer cents (e.g. `rate: 13000` === $130.00).
 */

/** Spring-Data page envelope Tekmetric wraps list responses in. */
export interface TekRawPage<T> {
  content: T[];
  totalPages: number;
  totalElements: number;
  number: number; // 0-based current page
  size: number;
  last: boolean;
  first?: boolean;
  numberOfElements?: number;
  empty?: boolean;
}

/** { id, code, name } lookup object Tekmetric uses for enums. */
export interface TekRawCodeName {
  id: number;
  code: string;
  name: string;
}

export interface TekRawLabor {
  id: number;
  name: string | null;
  /** Labor rate in cents. */
  rate: number;
  /** Billed labor hours for this labor line. */
  hours: number;
  technicianId?: number | null;
  complete?: boolean;
}

export interface TekRawPart {
  id: number;
  quantity: number;
  /** Unit cost in cents (what the shop paid). */
  cost: number;
  /** Unit retail in cents (what the customer is charged). */
  retail: number;
  name?: string | null;
  brand?: string | null;
  partNumber?: string | null;
}

export interface TekRawJob {
  id: number;
  repairOrderId: number;
  vehicleId: number | null;
  customerId: number | null;
  name: string | null;
  jobCategoryName?: string | null;
  technicianId: number | null;
  authorized?: boolean | null;
  selected?: boolean | null;
  archived?: boolean | null;
  /** Total parts sales in cents (pre-tax, pre-discount). */
  partsTotal: number;
  /** Total labor sales in cents (pre-tax, pre-discount). */
  laborTotal: number;
  /** Total discounts in cents. */
  discountTotal: number;
  /** Total fees in cents. */
  feeTotal: number;
  /** parts + labor + fees − discounts, in cents (pre-tax). */
  subtotal: number;
  /** Billed (sold) labor hours across the job's labor lines. */
  laborHours?: number | null;
  /** Actual hours the tech clocked (job clock). */
  loggedHours?: number | null;
  labor?: TekRawLabor[];
  parts?: TekRawPart[];
  completedDate?: string | null;
  createdDate?: string | null;
  updatedDate?: string | null;
}

export interface TekRawSubletItem {
  id: number;
  cost: number; // cents
  price: number; // cents
}

export interface TekRawSublet {
  id: number;
  name: string | null;
  /** Sublet sell price in cents. */
  price: number;
  /** Sublet cost in cents. */
  cost: number;
  items?: TekRawSubletItem[];
}

export interface TekRawRepairOrder {
  id: number;
  repairOrderNumber: number;
  shopId: number;
  repairOrderStatus: TekRawCodeName;
  customerId: number | null;
  /** RO-level default technician (may be null; jobs carry their own). */
  technicianId: number | null;
  /** Tekmetric's term for the service advisor. */
  serviceWriterId: number | null;
  vehicleId: number | null;
  milesIn?: number | null;
  milesOut?: number | null;
  completedDate?: string | null;
  postedDate?: string | null;
  createdDate?: string | null;
  updatedDate?: string | null;
  deletedDate?: string | null;
  /** Total labor sales in cents (pre-tax, pre-discount). */
  laborSales: number;
  /** Total parts sales in cents (pre-tax, pre-discount). */
  partsSales: number;
  /** Total sublet sales in cents (pre-tax, pre-discount). */
  subletSales: number;
  /** Total fees in cents. */
  feeTotal: number;
  /** Total discounts in cents. */
  discountTotal: number;
  /** Tax in cents. */
  taxes: number;
  /** Amount the customer has paid, in cents. */
  amountPaid: number;
  /** Grand total in cents (labor+parts+sublet+fees−discounts+taxes). */
  totalSales: number;
  jobs?: TekRawJob[];
  sublets?: TekRawSublet[];
}

export interface TekRawVehicle {
  id: number;
  customerId: number | null;
  year: number | null;
  make: string | null;
  model: string | null;
  subModel?: string | null;
  deletedDate?: string | null;
}

export interface TekRawAppointment {
  id: number;
  shopId: number;
  customerId: number | null;
  vehicleId: number | null;
  startTime: string | null;
  endTime?: string | null;
  /** Tekmetric exposes only a boolean here — no arrival timestamp. */
  arrived: boolean | null;
  /** NONE | ARRIVED | NO_SHOW | CANCELED */
  appointmentStatus: string | null;
  deletedDate?: string | null;
}

export interface TekRawEmployee {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email?: string | null;
  /** { id, code, name } — name is e.g. "Service Advisor" or "Technician". */
  employeeRole: TekRawCodeName | null;
  /** True for employees who perform billable work (technicians). */
  canPerformWork: boolean | null;
  deletedDate?: string | null;
}

export interface TekRawShop {
  id: number;
  name: string;
}
