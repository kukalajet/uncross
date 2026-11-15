// The values an order carries. Prices and quantities are safe integers: a
// price counts the instrument's ticks and a quantity counts its lots
// (docs/DESIGN.md, "Early decisions").

type Side = "buy" | "sell";
type Price = number;
type Quantity = number;
type OrderId = number;

export { type OrderId, type Price, type Quantity, type Side };
