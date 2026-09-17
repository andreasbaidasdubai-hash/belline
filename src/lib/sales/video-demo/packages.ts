import {
  VIDEO_RECEPTIONIST_TEXT,
  allowanceFeatures,
  annualPerMonth,
  periodFee,
  priceOf,
  sellable,
  videoAllowanceText,
  videoLive,
  type ProductId,
} from "../../billing/plans";
import { formatMoney, type Market } from "../../markets";

/**
 * The packages on a personalised demo page, generated from the catalogue
 * (billing/plans.ts), never typed: the same prices, allowances and
 * "Recommended" the website's pricing shows. Video lines appear only while
 * the video receptionist may be described as working (`videoLive`).
 */

export interface DemoPackage {
  id: ProductId;
  name: string;
  summary: string;
  recommended: boolean;
  monthly: string;
  annualPerMonth: string;
  annualBilled: string;
  voice: string;
  video: string | null;
  text: string;
  /** Users, then what this plan adds to the one below it. Live features only. */
  extras: string[];
}

const isVideoText = (text: string) => text === VIDEO_RECEPTIONIST_TEXT || / video minutes \(/.test(text);

export function demoPackages(market: Market = "AE"): DemoPackage[] {
  const plans = sellable(market);
  const money = (minor: number) => formatMoney(minor, market);
  const liveFeatures = (i: number) => (plans[i]?.features ?? []).filter((f) => f.status === "live" && !isVideoText(f.text)).map((f) => f.text);
  return plans.map((product, i) => {
    const allowances = allowanceFeatures(product).filter((f) => f.status === "live" && !isVideoText(f.text)).map((f) => f.text);
    const pools = Object.values(product.pools ?? {}).filter((n) => typeof n === "number").length;
    const below = i > 0 ? liveFeatures(i - 1) : null;
    const own = below ? liveFeatures(i).filter((f) => !below.includes(f)) : [];
    return {
      id: product.id,
      name: product.name,
      summary: product.summary,
      recommended: Boolean(product.recommended),
      monthly: money(priceOf(product.id, market)),
      annualPerMonth: money(annualPerMonth([product.id], market)),
      annualBilled: money(periodFee([product.id], market, "annual")),
      voice: allowances[0] ?? "",
      video: videoLive() ? videoAllowanceText(product.pools?.minutes ?? 0) : null,
      text: allowances[1] ?? "",
      extras: [...allowances.slice(pools), ...own],
    };
  });
}

/** A plan the demo page may send to checkout: one on sale in the market, else none. */
export function demoPlanId(raw: string | null | undefined, market: Market = "AE"): ProductId | null {
  return sellable(market).find((p) => p.id === raw)?.id ?? null;
}
