/**
 * Generates a Tableau-Superstore-style sample dataset.
 *
 * The output is deterministic (fixed PRNG seed) so that screenshots, tests, and
 * any numbers quoted in documentation stay stable between runs.
 *
 * Run with:  npm run seed
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(HERE, '..', 'data', 'superstore.csv');

/** Mulberry32: small, fast, well-distributed deterministic PRNG. */
function createRandom(seed: number) {
  let state = seed >>> 0;
  return function random(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = createRandom(20240517);

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(random() * items.length)];
}

function between(min: number, max: number): number {
  return min + random() * (max - min);
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

interface Category {
  name: string;
  subCategories: string[];
  products: string[];
  /** Typical unit price range for this category. */
  price: [number, number];
  /** Typical margin as a fraction of sales. */
  margin: [number, number];
}

const CATEGORIES: Category[] = [
  {
    name: 'Furniture',
    subCategories: ['Bookcases', 'Chairs', 'Furnishings', 'Tables'],
    products: [
      'Bush Somerset Collection Bookcase',
      'Hon Deluxe Fabric Upholstered Stacking Chairs',
      'Global Deluxe Stacking Chair',
      'Riverside Palais Royal Table',
      'Bevis Conference Table',
      'Sauder Camden County Bookcase',
      'Chromcraft Bull-Nose Wood Table',
      'Luxo Economy Swing Arm Lamp',
      'Eldon Wall Hutch',
    ],
    price: [45, 1800],
    margin: [-0.15, 0.28],
  },
  {
    name: 'Office Supplies',
    subCategories: ['Appliances', 'Art', 'Binders', 'Envelopes', 'Labels', 'Paper', 'Storage', 'Supplies'],
    products: [
      'Fellowes PB500 Electric Punch',
      'Avery Durable Binder',
      'Boston Model 1800 Electric Pencil Sharpener',
      'Wilson Jones Data Binder',
      'Xerox 1967 Copy Paper',
      'Easy-staple Paper',
      'Staple envelope',
      'Self-Adhesive Address Labels',
      'Rogers File Storage Box',
      'Iceberg Mobile File Cart',
      'Hoover Upright Vacuum',
    ],
    price: [2.5, 320],
    margin: [0.05, 0.55],
  },
  {
    name: 'Technology',
    subCategories: ['Accessories', 'Copiers', 'Machines', 'Phones'],
    products: [
      'Logitech MX Master Wireless Mouse',
      'Apple iPhone 14',
      'Samsung Galaxy S22',
      'Sharp AL-1530CS Digital Copier',
      'Canon PC1060 Personal Copier',
      'Hewlett Packard LaserJet 3310',
      'Konica Minolta bizhub Copier',
      'Plantronics Headset',
      'Belkin USB Cable',
      'Docking Station USB 3.0',
    ],
    price: [12, 5600],
    margin: [-0.2, 0.42],
  },
];

const REGIONS: Record<string, { states: string[]; cities: string[] }> = {
  East: {
    states: ['New York', 'Pennsylvania', 'Ohio', 'Massachusetts', 'New Jersey', 'Virginia'],
    cities: ['New York City', 'Philadelphia', 'Columbus', 'Boston', 'Newark', 'Richmond'],
  },
  West: {
    states: ['California', 'Washington', 'Arizona', 'Colorado', 'Nevada', 'Oregon'],
    cities: ['Los Angeles', 'Seattle', 'Phoenix', 'Denver', 'Las Vegas', 'Portland'],
  },
  Central: {
    states: ['Texas', 'Illinois', 'Michigan', 'Minnesota', 'Missouri', 'Wisconsin'],
    cities: ['Houston', 'Chicago', 'Detroit', 'Minneapolis', 'Kansas City', 'Milwaukee'],
  },
  South: {
    states: ['Florida', 'Georgia', 'North Carolina', 'Tennessee', 'Louisiana', 'Alabama'],
    cities: ['Miami', 'Atlanta', 'Charlotte', 'Nashville', 'New Orleans', 'Birmingham'],
  },
};

const SEGMENTS = ['Consumer', 'Corporate', 'Home Office'] as const;
const SHIP_MODES = ['Standard Class', 'Second Class', 'First Class', 'Same Day'] as const;
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'] as const;

const FIRST_NAMES = [
  'Aaron', 'Brenda', 'Caleb', 'Diana', 'Ethan', 'Fiona', 'Grace', 'Henry', 'Irene', 'Jamal',
  'Karen', 'Liam', 'Mona', 'Nathan', 'Olivia', 'Priya', 'Quentin', 'Rosa', 'Samuel', 'Tanya',
  'Uma', 'Victor', 'Wendy', 'Xavier', 'Yara', 'Zachary',
];

const LAST_NAMES = [
  'Bergman', 'Chen', 'Delgado', 'Everett', 'Fischer', 'Gupta', 'Hoffman', 'Ibrahim', 'Jensen',
  'Kowalski', 'Lindqvist', 'Moreau', 'Nguyen', 'Okafor', 'Petrov', 'Quinlan', 'Ramirez', 'Sato',
  'Thompson', 'Ueda', 'Vasquez', 'Whitfield', 'Yamamoto', 'Zimmerman',
];

/** The four Superstore order years, kept aligned with the real dataset. */
const YEARS = [2021, 2022, 2023, 2024];

interface Row {
  orderId: string;
  orderDate: Date;
  shipDate: Date;
  shipMode: string;
  customerId: string;
  customerName: string;
  segment: string;
  country: string;
  city: string;
  state: string;
  postalCode: number;
  region: string;
  productId: string;
  category: string;
  subCategory: string;
  productName: string;
  sales: number;
  quantity: number;
  discount: number;
  profit: number;
  priority: string;
}

const rows: Row[] = [];
const customerPool = Array.from({ length: 780 }, (_, i) => ({
  id: `CG-${12000 + i}`,
  name: `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
  segment: pick(SEGMENTS),
}));

let orderCounter = 1000;

/** A single order contributes between 1 and 6 line items. */
for (const year of YEARS) {
  // 400 orders/year at ~3.4 line items each lands the dataset around 5.5k rows,
  // which is the same order of magnitude as the real Superstore sample and
  // keeps every interaction comfortably interactive.
  const ordersThisYear = 400;

  for (let o = 0; o < ordersThisYear; o++) {
    const orderId = `US-${year}-${orderCounter++}`;
    const customer = pick(customerPool);

    const monthIndex = Math.floor(random() * 12);
    const day = 1 + Math.floor(random() * 28);
    const orderDate = new Date(Date.UTC(year, monthIndex, day));

    const shipMode = pick(SHIP_MODES);
    const leadDays = shipMode === 'Same Day' ? 0 : shipMode === 'First Class' ? 2 : shipMode === 'Second Class' ? 4 : 6;
    const shipDate = new Date(orderDate.getTime() + (leadDays + Math.floor(random() * 2)) * 86400000);

    const regionName = pick(Object.keys(REGIONS));
    const region = REGIONS[regionName];
    const cityIndex = Math.floor(random() * region.cities.length);

    // Consumers cluster in a few states, which makes geographic views interesting.
    const state = region.states[cityIndex % region.states.length];
    const city = region.cities[cityIndex];
    const postalCode = 10000 + Math.floor(random() * 89999);

    const lineItems = 1 + Math.floor(random() * 6);
    const category = pick(CATEGORIES);

    for (let line = 0; line < lineItems; line++) {
      const subCategory = pick(category.subCategories);
      const productName = pick(category.products);

      // Quantity is usually small; occasional bulk orders create outliers.
      const quantity = random() < 0.85 ? 1 + Math.floor(random() * 5) : 6 + Math.floor(random() * 9);

      const unitPrice = round(between(category.price[0], category.price[1]), 2);
      const discount = random() < 0.4 ? round(pick([0.1, 0.15, 0.2, 0.3, 0.4]), 2) : 0;

      const gross = unitPrice * quantity;
      const sales = round(gross * (1 - discount), 2);

      // Margin varies by category, and deep discounts push profit negative.
      const baseMargin = between(category.margin[0], category.margin[1]);
      const margin = baseMargin - discount * 0.9;
      const profit = round(sales * margin, 2);

      const productId = `${category.name.slice(0, 3).toUpperCase()}-${subCategory.slice(0, 2).toUpperCase()}-${1000000 + Math.floor(random() * 8999999)}`;

      rows.push({
        orderId,
        orderDate,
        shipDate,
        shipMode,
        customerId: customer.id,
        customerName: customer.name,
        segment: customer.segment,
        country: 'United States',
        city,
        state,
        postalCode,
        region: regionName,
        productId,
        category: category.name,
        subCategory,
        productName,
        sales,
        quantity,
        discount,
        profit,
        priority: pick(PRIORITIES),
      });
    }
  }
}

const HEADER = [
  'Row ID',
  'Order ID',
  'Order Date',
  'Ship Date',
  'Ship Mode',
  'Customer ID',
  'Customer Name',
  'Segment',
  'Country',
  'City',
  'State',
  'Postal Code',
  'Region',
  'Product ID',
  'Category',
  'Sub-Category',
  'Product Name',
  'Sales',
  'Quantity',
  'Discount',
  'Profit',
  'Order Priority',
];

/** Escapes a field for CSV output. */
function escape(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function formatDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const lines = [HEADER.join(',')];

rows.forEach((row, i) => {
  lines.push(
    [
      i + 1,
      row.orderId,
      formatDate(row.orderDate),
      formatDate(row.shipDate),
      row.shipMode,
      row.customerId,
      row.customerName,
      row.segment,
      row.country,
      row.city,
      row.state,
      row.postalCode,
      row.region,
      row.productId,
      row.category,
      row.subCategory,
      // Quote product names that contain commas.
      escape(row.productName),
      row.sales.toFixed(2),
      row.quantity,
      row.discount.toFixed(2),
      row.profit.toFixed(2),
      row.priority,
    ].join(','),
  );
});

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, lines.join('\n') + '\n', 'utf8');

const totalSales = rows.reduce((acc, r) => acc + r.sales, 0);
const totalProfit = rows.reduce((acc, r) => acc + r.profit, 0);

console.log(`Wrote ${rows.length} rows to ${OUTPUT}`);
console.log(`Columns: ${HEADER.length}`);
console.log(`Total sales:  $${totalSales.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
console.log(`Total profit: $${totalProfit.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
