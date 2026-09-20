import express from "express";
import { config } from "./config";
import { ordersRouter } from "./routes/orders";
import { authRouter } from "./routes/auth";

const app = express();
app.use(express.json());
app.use(ordersRouter);
app.use(authRouter);

app.listen(config.port, () => {
  console.log(`shop listening on ${config.port}`);
});
