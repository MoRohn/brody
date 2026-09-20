import { Sequelize, DataTypes } from "sequelize";
import { config } from "../config";

const sequelize = new Sequelize(config.databaseUrl);

/** A customer account. */
export const User = sequelize.define("User", {
  email: { type: DataTypes.STRING },
  passwordHash: { type: DataTypes.STRING },
});

/** A placed order and its payment state. */
export const Order = sequelize.define("Order", {
  userId: { type: DataTypes.INTEGER },
  totalCents: { type: DataTypes.INTEGER },
  status: { type: DataTypes.STRING },
  chargeId: { type: DataTypes.STRING },
});
