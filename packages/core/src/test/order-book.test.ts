import { assert, describe, it } from "@effect/vitest";

import {
  addOrder,
  bestOrder,
  createOrderBook,
  type OrderBook,
  reduceOrder,
  removeOrder,
  type RestingOrder,
} from "../order-book.ts";
import type { Side } from "../order.ts";

const buy = (id: number, price: number, quantity: number): RestingOrder => ({
  id,
  side: "buy",
  price,
  quantity,
});

const sell = (id: number, price: number, quantity: number): RestingOrder => ({
  id,
  side: "sell",
  price,
  quantity,
});

const bookWith = (...orders: Array<RestingOrder>): OrderBook => {
  const book = createOrderBook();

  for (const order of orders) addOrder(book, order);

  return book;
};

// A side's price levels, best first, each as its price, its total quantity,
// and the ids of its orders in time priority.
const depth = (book: OrderBook, side: Side) =>
  (side === "buy" ? book.bids : book.asks).map((level) => [
    level.price,
    level.quantity,
    [...level.orders.keys()],
  ]);

describe("order book", () => {
  it("ranks bids from the highest price and asks from the lowest", () => {
    const book = bookWith(
      buy(1, 100, 5),
      buy(2, 102, 3),
      buy(3, 101, 4),
      sell(4, 105, 2),
      sell(5, 103, 6),
      sell(6, 104, 1),
    );

    assert.deepStrictEqual(depth(book, "buy"), [
      [102, 3, [2]],
      [101, 4, [3]],
      [100, 5, [1]],
    ]);

    assert.deepStrictEqual(depth(book, "sell"), [
      [103, 6, [5]],
      [104, 1, [6]],
      [105, 2, [4]],
    ]);
  });

  it("queues orders at one price in arrival order and totals them", () => {
    const book = bookWith(buy(1, 100, 5), buy(2, 100, 3), buy(3, 100, 2));

    assert.deepStrictEqual(depth(book, "buy"), [[100, 10, [1, 2, 3]]]);
  });

  it("gives the oldest order at the best price as each side's best order", () => {
    const book = bookWith(
      buy(1, 100, 5),
      buy(2, 101, 3),
      buy(3, 101, 2),
      sell(4, 103, 1),
      sell(5, 103, 7),
    );

    assert.deepStrictEqual(bestOrder(book, "buy"), buy(2, 101, 3));
    assert.deepStrictEqual(bestOrder(book, "sell"), sell(4, 103, 1));
    assert.isUndefined(bestOrder(createOrderBook(), "buy"));
    assert.isUndefined(bestOrder(createOrderBook(), "sell"));
  });

  it("removes an order with what is left of it, and the others keep their places", () => {
    const book = bookWith(buy(1, 100, 5), buy(2, 100, 3), buy(3, 100, 2));

    assert.deepStrictEqual(removeOrder(book, 2), buy(2, 100, 3));
    assert.deepStrictEqual(depth(book, "buy"), [[100, 7, [1, 3]]]);
  });

  it("drops a price level once its last order leaves", () => {
    const book = bookWith(buy(1, 100, 5), buy(2, 101, 3));

    removeOrder(book, 2);

    assert.deepStrictEqual(depth(book, "buy"), [[100, 5, [1]]]);
    assert.deepStrictEqual(bestOrder(book, "buy"), buy(1, 100, 5));
  });

  it("removes nothing for an id that is not resting", () => {
    const book = bookWith(buy(1, 100, 5));

    assert.isUndefined(removeOrder(book, 9));
    assert.deepStrictEqual(removeOrder(book, 1), buy(1, 100, 5));
    assert.isUndefined(removeOrder(book, 1));
    assert.deepStrictEqual(depth(book, "buy"), []);
  });

  it("reduces an order and its level by a partial fill, keeping its place", () => {
    const first = buy(1, 100, 5);
    const book = bookWith(first, buy(2, 100, 3));

    reduceOrder(book, first, 2);

    assert.deepStrictEqual(depth(book, "buy"), [[100, 6, [1, 2]]]);
    assert.deepStrictEqual(bestOrder(book, "buy"), buy(1, 100, 3));
  });
});
