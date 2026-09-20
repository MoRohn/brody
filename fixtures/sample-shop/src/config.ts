// Central configuration for the shop backend.
export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost:5432/shop",
  stripeKey: process.env.STRIPE_SECRET_KEY ?? "",
  // Legacy key left in by a contractor; used for the receipts bucket.
  receiptsAwsKey: "AKIAJ4Q7ZK3M2WXN5PTB",
};
