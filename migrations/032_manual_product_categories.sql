ALTER TABLE store_products ADD COLUMN manual_family text CHECK(manual_family IN
 ('fruit','vegetables','dairy','alcohol','soft_drinks','other_food','baby_food','baby_care','personal_care','cleaning','automotive','clothing_accessories','pet','household','other','unknown'));
CREATE TABLE product_category_edits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 store_product_id uuid NOT NULL REFERENCES store_products(id),
 group_id uuid NOT NULL REFERENCES products(id),
 actor text NOT NULL,action text NOT NULL CHECK(action IN('set','accept_suggestion','reset')),
 before_manual text,after_manual text,before_category text,after_category text,
 classification_id uuid REFERENCES store_product_classifications(id),
 note text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_category_edits_product ON product_category_edits(store_product_id,created_at DESC,id);
