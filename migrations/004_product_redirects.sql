ALTER TABLE products ADD COLUMN redirect_id uuid REFERENCES products(id);
