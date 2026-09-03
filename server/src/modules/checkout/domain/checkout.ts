import type { FastifyReply } from "fastify";
export interface CheckoutOrder {
  id: string;
  total: number;
}

export function priceOrder(order: CheckoutOrder, reply?: FastifyReply): number {
  return order.total;
}
