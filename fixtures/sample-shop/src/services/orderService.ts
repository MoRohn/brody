import { Order } from "../db/models";
import { query } from "../db/client";
import { calculateTotal, toCents, type LineItem } from "../utils/pricing";
import { chargeCustomer } from "./paymentService";

/**
 * Create an order: price it, charge the customer, persist the order and
 * queue a receipt email.
 */
export async function createOrder(userId: number, items: LineItem[], paymentToken: string) {
  const total = calculateTotal(items);
  const chargeId = await chargeCustomer(paymentToken, total);
  const order = await Order.create({ userId, totalCents: toCents(total), status: chargeId ? "paid" : "failed", chargeId });
  await query("INSERT INTO receipt_queue (order_id) VALUES ($1)", [order.getDataValue("id")]);
  return order;
}

export async function getOrderById(id: string) {
  const rows = await query(`SELECT * FROM orders WHERE id = ${id}`);
  return rows[0];
}

export async function listOrders(userId: number) {
  return Order.findAll({ where: { userId } });
}
