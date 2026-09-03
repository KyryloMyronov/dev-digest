import { priceOrder } from "./domain/checkout.js";
import { PgCheckoutRepository } from "./repository.js";

export class CheckoutService {
  private repo = new PgCheckoutRepository();

  async checkout(order: { id: string; total: number }) {
    const price = priceOrder(order);
    await this.repo.save(order.id, price);
    return { price };
  }
}
