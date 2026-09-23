import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cloudKeyFingerprint,
  cloudKeyNeedsRebinding,
  defaultCloudDomainsFor,
} from "../extensions/alibaba.ts";

const CN = "dashscope.aliyuncs.com";
const INTL = "dashscope-intl.aliyuncs.com";
const US = "dashscope-us.aliyuncs.com";

describe("cloudKeyFingerprint", () => {
  it("is stable, key-specific, and leaks nothing", () => {
    const key = "sk-sp-abcdef1234567890";
    assert.equal(cloudKeyFingerprint(key), cloudKeyFingerprint(key));
    assert.notEqual(cloudKeyFingerprint(key), cloudKeyFingerprint("sk-sp-other-key-000"));
    assert.match(cloudKeyFingerprint(key), /^[0-9a-f]{16}$/);
    assert.ok(!cloudKeyFingerprint(key).includes("abcdef"));
    assert.ok(!key.includes(cloudKeyFingerprint(key)));
  });
});

describe("cloudKeyNeedsRebinding", () => {
  const key = "sk-sp-1234567890";
  const bound = { cloudKeyFingerprint: cloudKeyFingerprint(key) };

  it("never fires without a key", () => {
    assert.equal(cloudKeyNeedsRebinding(bound, null), false);
    assert.equal(cloudKeyNeedsRebinding(bound, undefined), false);
    assert.equal(cloudKeyNeedsRebinding({}, null), false);
  });

  it("fires when the key changed — or was never bound", () => {
    assert.equal(cloudKeyNeedsRebinding(bound, "sk-sp-a-different-key"), true);
    assert.equal(cloudKeyNeedsRebinding({}, key), true);
    assert.equal(cloudKeyNeedsRebinding({ cloudKeyFingerprint: "0123456789abcdef" }, key), true);
  });

  it("stays quiet while the key matches the binding", () => {
    assert.equal(cloudKeyNeedsRebinding(bound, key), false);
  });
});

describe("defaultCloudDomainsFor", () => {
  it("checks the region's own default first (Beijing behind a cn-beijing endpoint)", () => {
    assert.deepEqual(defaultCloudDomainsFor("llm-abc123.cn-beijing.maas.aliyuncs.com"), [CN, INTL, US]);
    assert.deepEqual(defaultCloudDomainsFor("dashscope.aliyuncs.com"), [CN, INTL, US]);
  });

  it("follows the configured region for the other sites", () => {
    assert.deepEqual(defaultCloudDomainsFor("llm-abc123.ap-southeast-1.maas.aliyuncs.com"), [INTL, CN, US]);
    assert.deepEqual(defaultCloudDomainsFor("dashscope-us.aliyuncs.com"), [US, CN, INTL]);
    assert.deepEqual(defaultCloudDomainsFor("llm-abc123.us-east-1.maas.aliyuncs.com"), [US, CN, INTL]);
  });

  it("starts from the international default where no region maps (Tokyo, Frankfurt, HK, custom)", () => {
    assert.deepEqual(defaultCloudDomainsFor("llm-abc123.ap-northeast-1.maas.aliyuncs.com"), [INTL, CN, US]);
    assert.deepEqual(defaultCloudDomainsFor("llm-abc123.eu-central-1.maas.aliyuncs.com"), [INTL, CN, US]);
    assert.deepEqual(defaultCloudDomainsFor("cn-hongkong.dashscope.aliyuncs.com"), [INTL, CN, US]);
    assert.deepEqual(defaultCloudDomainsFor("proxy.example.com"), [INTL, CN, US]);
    assert.deepEqual(defaultCloudDomainsFor(""), [INTL, CN, US]);
  });
});
