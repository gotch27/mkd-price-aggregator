export type BrandAlias = { id: string; name: string; retailer: string | null };
export type Brand = {
  id: string;
  slug: string;
  name: string;
  aliases: BrandAlias[];
  product_count: number;
  revision: number;
};
export type BrandPage = {
  rows: Brand[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
};
export type BrandOption = { id: string; name: string };
export type BrandInput = {
  name: string;
  aliases: { name: string; retailer: string | null }[];
};
export class BrandConflict extends Error {}
