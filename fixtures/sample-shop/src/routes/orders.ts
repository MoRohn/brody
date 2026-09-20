import { Router } from "express";
import { requireAuth } from "./auth";
import { createOrder, getOrderById, listOrders } from "../services/orderService";

export const ordersRouter = Router();

ordersRouter.post("/api/orders", requireAuth, async (req, res) => {
  const order = await createOrder(req.body.userId, req.body.items, req.body.paymentToken);
  res.status(201).json(order);
});

ordersRouter.get("/api/orders/:id", async (req, res) => {
  const order = await getOrderById(req.params.id);
  res.json(order);
});

ordersRouter.get("/api/orders", requireAuth, async (req, res) => {
  res.json(await listOrders(Number(req.query.userId)));
});
