import type {
  CategoryEditInput,
  CategorySaveResult,
} from "@/nextsignal/domain/product-categories";
import { taskApi } from "./task-api";

export function saveCategoryChoice(
  input: CategoryEditInput,
  onUnauthorized: () => void,
) {
  const { id, ...body } = input;
  return taskApi<CategorySaveResult>(
    `/api/products/${id}/category`,
    onUnauthorized,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}
