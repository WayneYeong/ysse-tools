const fs = require("fs");
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require("@firebase/rules-unit-testing");

async function main() {
  const testEnv = await initializeTestEnvironment({
    projectId: "rules-test-project",
    firestore: {
      rules: fs.readFileSync("./firestore.rules", "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });

  // Seed Wayne's real-world user doc exactly as shown in the Firebase Console screenshot:
  // role "owner", no customerId field at all.
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.collection("ysse_users").doc("yeongww77@gmail.com").set({
      email: "yeongww77@gmail.com",
      name: "Wayne",
      position: "Manager",
      role: "owner",
      addedBy: "bootstrap",
      addedAt: 1781932990707,
    });
    await db.collection("ysse_tracker").doc("shared_projects").set({ projects: [{ id: "x" }] });
    await db.collection("ysse_settings").doc("company").set({ companyName: "YSSE Fabricator Sdn Bhd" });
  });

  const wayne = testEnv.authenticatedContext("wayne-uid", { email: "yeongww77@gmail.com" });
  const db = wayne.firestore();

  async function check(label, promise) {
    try {
      await promise;
      console.log(`[ALLOW]  ${label}`);
    } catch (e) {
      console.log(`[DENY]   ${label}`);
      console.log(`         code=${e.code}`);
      console.log(`         message=${e.message}`);
    }
  }

  await check("read ysse_tracker/shared_projects", db.collection("ysse_tracker").doc("shared_projects").get().then(d => { if (!d.exists) throw new Error("doc missing"); }));
  await check("read ysse_settings/company", db.collection("ysse_settings").doc("company").get().then(d => { if (!d.exists) throw new Error("doc missing"); }));
  await check("read ysse_users/yeongww77@gmail.com (self)", db.collection("ysse_users").doc("yeongww77@gmail.com").get().then(d => { if (!d.exists) throw new Error("doc missing"); }));

  await check("read ysse_quotation/shared_matdb", db.collection("ysse_quotation").doc("shared_matdb").get());
  await check("write ysse_settings/company (update companyName)", db.collection("ysse_settings").doc("company").set({ companyName: "Test Update" }, { merge: true }));
  await check("owner updates own branch field on legacy doc with no customerId (the reported bug)", db.collection("ysse_users").doc("yeongww77@gmail.com").set({ branch: "Kuching" }, { merge: true }));

  // Second tenant with an explicit customerId field, plus a cross-tenant negative test.
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db2 = context.firestore();
    await db2.collection("ysse_users").doc("siti@wawastrading.my").set({
      email: "siti@wawastrading.my", role: "management", customerId: "wawas-trading",
      permissions: { dashboard: true, quotation: false, settings: false },
    });
    await db2.collection("ysse_tracker").doc("wawas-trading").set({ projects: [] });
  });
  const siti = testEnv.authenticatedContext("siti-uid", { email: "siti@wawastrading.my" });
  const dbSiti = siti.firestore();

  console.log("--- second tenant (explicit customerId, management role) ---");
  await check("siti reads her own tenant's tracker doc", dbSiti.collection("ysse_tracker").doc("wawas-trading").get().then(d => { if (!d.exists) throw new Error("missing"); }));
  await check("siti reads HER OWN tenant's quotation (should be DENY: quotation permission off)", dbSiti.collection("ysse_quotation").doc("wawas-trading").get());
  console.log("--- cross-tenant negative test (must stay DENY) ---");
  await check("siti tries to read YSSE's tracker doc (must be DENY)", dbSiti.collection("ysse_tracker").doc("shared_projects").get());
  await check("wayne tries to read Wawas's tracker doc (must be DENY)", db.collection("ysse_tracker").doc("wawas-trading").get());

  // Siti the engineer (qs role) at YSSE itself - the exact bug just reported: a qs account
  // should be able to read the company settings/branches doc, same as owner/management.
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().collection("ysse_users").doc("siti.engineer@ysse.com.my").set({
      email: "siti.engineer@ysse.com.my", role: "qs", customerId: "ysse",
    });
  });
  const sitiQs = testEnv.authenticatedContext("siti-qs-uid", { email: "siti.engineer@ysse.com.my" });
  await check("qs role reads ysse_settings/company (was broken)", sitiQs.firestore().collection("ysse_settings").doc("company").get().then(d => { if (!d.exists) throw new Error("missing"); }));
  await check("qs role write to ysse_settings (must stay DENY - settings is mgmt-only)", sitiQs.firestore().collection("ysse_settings").doc("company").set({ companyName: "should fail" }, { merge: true }));

  // Phase 2 of the ysse_users cross-tenant read leak fix: listing the collection must now be
  // scoped to exactly one tenant via .where('customerId','==', X) - both Wayne's tenant query
  // and Siti's tenant query should succeed and return only their own docs, an unscoped list
  // must be denied outright, and Siti must not be able to read YSSE's user list by spoofing
  // the where() filter to someone else's customerId.
  console.log("--- ysse_users list scoping (phase 2) ---");
  await check("wayne lists ysse_users scoped to his own tenant (ysse)", db.collection("ysse_users").where("customerId", "==", "ysse").get().then(s => { if (s.empty) throw new Error("expected docs"); }));
  await check("wayne lists ysse_users UNSCOPED - no where() clause (must be DENY)", db.collection("ysse_users").get());
  await check("siti lists her own tenant's users (wawas-trading)", dbSiti.collection("ysse_users").where("customerId", "==", "wawas-trading").get().then(s => { if (s.empty) throw new Error("expected docs"); }));
  await check("siti tries to list YSSE's users by spoofing the where() filter (must be DENY)", dbSiti.collection("ysse_users").where("customerId", "==", "ysse").get());
  await check("wayne still reads his OWN doc by id directly (must stay ALLOW)", db.collection("ysse_users").doc("yeongww77@gmail.com").get().then(d => { if (!d.exists) throw new Error("missing"); }));

  // Item 3: ysse_pending_quotes and ysse_quotes both had a combined "allow read" depending on
  // resource.data, which does NOT filter a list() query the way it filters a get() - an unscoped
  // listener actually returned every tenant's documents. get/list are now split, with list
  // requiring a direct resource.data.customerId match the query can be verified against.
  console.log("--- ysse_pending_quotes / ysse_quotes list scoping (item 3) ---");
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().collection("ysse_pending_quotes").doc("q1").set({ customerId: "ysse", project: { name: "MineA" } });
    await context.firestore().collection("ysse_pending_quotes").doc("q2").set({ customerId: "wawas-trading", project: { name: "NotMineB" } });
    await context.firestore().collection("ysse_quotes").doc("qq1").set({ customerId: "ysse", name: "MyQuote" });
    await context.firestore().collection("ysse_quotes").doc("qq2").set({ customerId: "wawas-trading", name: "NotMyQuote" });
  });
  await check("wayne: UNSCOPED pendingCol.get() (must now be DENY)", db.collection("ysse_pending_quotes").get());
  await check("wayne: SCOPED pendingCol query returns only his own tenant's doc", db.collection("ysse_pending_quotes").where("customerId", "==", "ysse").get().then(s => {
    if (s.docs.length !== 1 || s.docs[0].id !== "q1") throw new Error("expected exactly q1, got " + s.docs.map(d => d.id).join(","));
  }));
  await check("wayne: UNSCOPED quotesCol.get() (must now be DENY)", db.collection("ysse_quotes").get());
  await check("wayne: SCOPED quotesCol query returns only his own tenant's doc", db.collection("ysse_quotes").where("customerId", "==", "ysse").get().then(s => {
    if (s.docs.length !== 1 || s.docs[0].id !== "qq1") throw new Error("expected exactly qq1, got " + s.docs.map(d => d.id).join(","));
  }));

  await testEnv.cleanup();
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
