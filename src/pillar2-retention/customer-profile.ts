import { Customer } from "../core/types";

// P2 owns this. Reads transactions + customers only — never writes
// reconciliation or statement tables (README section 9).
export function getCustomerProfile(_customerId: number): Customer {
  throw new Error("not implemented — P2");
}
