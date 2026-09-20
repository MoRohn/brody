import { Router } from "express";
import { User } from "../db/models";

export const authRouter = Router();

export function requireAuth(req: any, res: any, next: any) {
  if (!req.headers.authorization) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

authRouter.post("/api/login", async (req, res) => {
  const user = await User.findOne({ where: { email: req.body.email } });
  if (!user) return res.status(401).json({ error: "invalid credentials" });
  res.json({ token: Buffer.from(String(user.getDataValue("id"))).toString("base64") });
});

authRouter.post("/api/calc", (req, res) => {
  res.json({ result: eval(req.body.expression) });
});
