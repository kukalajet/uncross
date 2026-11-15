import type { OrderId, Price, Quantity, Side } from "./order.ts";

// An order waiting in the book for a counterparty. Its quantity is what is
// left of it after fills.
type RestingOrder = {
  readonly id: OrderId;
  readonly side: Side;
  readonly price: Price;
  quantity: Quantity;
};

// The orders resting at one price on one side. A Map keeps them in arrival
// order and deletes a cancelled one in constant time.
type PriceLevel = {
  readonly price: Price;
  quantity: Quantity;
  readonly orders: Map<OrderId, RestingOrder>;
};

// One instrument's resting orders. Each side lists its price levels best
// first: bids from the highest price down, asks from the lowest up.
type OrderBook = {
  readonly bids: Array<PriceLevel>;
  readonly asks: Array<PriceLevel>;
  readonly orders: Map<OrderId, RestingOrder>;
};

const createOrderBook = (): OrderBook => ({
  bids: [],
  asks: [],
  orders: new Map(),
});

const levelsOf = (book: OrderBook, side: Side): Array<PriceLevel> =>
  side === "buy" ? book.bids : book.asks;

// Price priority: a higher bid, or a lower ask, trades first.
const ranksAhead = (side: Side, price: Price, other: Price): boolean =>
  side === "buy" ? price > other : price < other;

// The index of the level at `price`, or of where that level belongs: the first
// level that does not rank ahead of `price`. New orders mostly arrive near the
// best price, so a scan from the best level is short.
const levelPosition = (
  levels: Array<PriceLevel>,
  side: Side,
  price: Price,
): number => {
  const position = levels.findIndex(
    (level) => !ranksAhead(side, level.price, price),
  );

  return position === -1 ? levels.length : position;
};

// Every resting order has a level, so a miss means this module broke the
// book, not that a command was bad.
const findLevel = (levels: Array<PriceLevel>, order: RestingOrder) => {
  const position = levelPosition(levels, order.side, order.price);
  const level = levels[position];

  if (level?.price !== order.price) {
    throw new Error(`Order ${order.id} rests at no price level`);
  }

  return { level, position };
};

// Rests an order behind every order already at its price, which gives time
// priority. The book keeps this object, and its id must not be resting yet.
const addOrder = (book: OrderBook, order: RestingOrder): void => {
  const levels = levelsOf(book, order.side);
  const position = levelPosition(levels, order.side, order.price);
  const level = levels[position];

  if (level?.price === order.price) {
    level.orders.set(order.id, order);
    level.quantity += order.quantity;
  } else {
    levels.splice(position, 0, {
      price: order.price,
      quantity: order.quantity,
      orders: new Map([[order.id, order]]),
    });
  }

  book.orders.set(order.id, order);
};

// The order that trades first against an incoming order from the other side:
// the oldest one at the best price.
const bestOrder = (book: OrderBook, side: Side): RestingOrder | undefined =>
  levelsOf(book, side)[0]?.orders.values().next().value;

// Takes part of a resting order, as a partial fill does, so `quantity` must be
// less than what is left of it. The order keeps its place in the queue. Taking
// all that is left is removeOrder.
const reduceOrder = (
  book: OrderBook,
  order: RestingOrder,
  quantity: Quantity,
): void => {
  const { level } = findLevel(levelsOf(book, order.side), order);

  order.quantity -= quantity;
  level.quantity -= quantity;
};

// Takes an order out of the book with all that is left of it, as a cancel or a
// complete fill does, and its price level with it when no order is left there.
// Undefined: no order rests under that id.
const removeOrder = (
  book: OrderBook,
  orderId: OrderId,
): RestingOrder | undefined => {
  const order = book.orders.get(orderId);

  if (order === undefined) return undefined;

  const levels = levelsOf(book, order.side);
  const { level, position } = findLevel(levels, order);

  level.orders.delete(order.id);
  level.quantity -= order.quantity;
  book.orders.delete(order.id);

  if (level.orders.size === 0) levels.splice(position, 1);

  return order;
};

export {
  addOrder,
  bestOrder,
  createOrderBook,
  type OrderBook,
  type PriceLevel,
  reduceOrder,
  removeOrder,
  type RestingOrder,
};
