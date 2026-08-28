import { apiRequest } from "./api-client";
import type { CreateProductInput, Product, UpdateProductInput } from "../types/domain";

export function listProducts(): Promise<Product[]> {
  return apiRequest<Product[]>("/products");
}

export function getProduct(id: number): Promise<Product> {
  return apiRequest<Product>(`/products/${id}`);
}

export function createProduct(input: CreateProductInput): Promise<Product> {
  return apiRequest<Product>("/products", { method: "POST", body: input });
}

export function updateProduct(id: number, input: UpdateProductInput): Promise<Product> {
  return apiRequest<Product>(`/products/${id}`, { method: "PATCH", body: input });
}
