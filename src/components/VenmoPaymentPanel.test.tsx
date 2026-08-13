import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VenmoPaymentPanel } from "./VenmoPaymentPanel";

test("renders one payment-specific Venmo handoff and an exact-note fallback", () => {
  const html = renderToStaticMarkup(
    <VenmoPaymentPanel courseNumber="CSCI 104" paidId="12345678" section="12345" semester="20263" showQr />,
  );

  assert.match(html, /Pay exactly \$1\.00 in Venmo/);
  assert.match(html, /Required payment note/);
  assert.match(html, /12345678/);
  assert.match(html, /separate \$1 payment for every section/);
  assert.match(html, /Never use 9020 as the payment note/);
  assert.match(html, /account\.venmo\.com\/pay\?[^"&amp;]*recipients=JonLuca/);
  assert.match(html, /note=12345678/);
  assert.doesNotMatch(html, /venmo\.com\/u\/jonluca/);
  assert.match(html, /<svg/);
});

test("does not show a QR when the compact handoff does not request one", () => {
  const html = renderToStaticMarkup(
    <VenmoPaymentPanel paidId="87654321" section="54321" semester="20263" showQr={false} />,
  );

  assert.doesNotMatch(html, /<svg/);
  assert.match(html, /87654321/);
});
