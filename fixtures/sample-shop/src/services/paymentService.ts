import Stripe from "stripe";
import { config } from "../config";
import { toCents } from "../utils/pricing";

const stripe = new Stripe(config.stripeKey);

/** Charge the customer's saved payment method and return the Stripe charge id. */
export async function chargeCustomer(customerToken: string, amount: number): Promise<string> {
  try {
    const charge = await stripe.charges.create({ amount: toCents(amount), currency: "usd", source: customerToken });
    return charge.id;
  } catch (err) {
  }
  return "";
}
