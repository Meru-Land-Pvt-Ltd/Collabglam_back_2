// delete-instantly-accounts-except-sophia.js

const axios = require("axios");

const BASE_URL =
  process.env.LOCAL_INSTANTLY_URL || "http://localhost:8000/instantly";

const KEEP_EMAILS = new Set([
  "sophia.green@collabglam.com",
]);

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

async function main() {
  console.log(`Fetching accounts from: ${BASE_URL}/accounts`);

  const listResponse = await axios.get(`${BASE_URL}/accounts`, {
    headers: {
      Accept: "application/json",
    },
  });

  const accounts = listResponse?.data?.data?.items || [];

  if (!accounts.length) {
    console.log("No Instantly accounts found.");
    return;
  }

  const toDelete = accounts
    .map((account) => normalizeEmail(account.email))
    .filter(Boolean)
    .filter((email) => !KEEP_EMAILS.has(email));

  console.log("\nAccounts found:");
  accounts.forEach((account) => {
    const email = normalizeEmail(account.email);
    console.log(`- ${email}${KEEP_EMAILS.has(email) ? "  [KEEP]" : "  [DELETE]"}`);
  });

  if (!toDelete.length) {
    console.log("\nNothing to delete. Only Sophia is present.");
    return;
  }

  console.log("\nDeleting accounts except Sophia...\n");

  for (const email of toDelete) {
    const encodedEmail = encodeURIComponent(email);

    try {
      const response = await axios.delete(
        `${BASE_URL}/accounts/${encodedEmail}`,
        {
          headers: {
            Accept: "application/json",
          },
          transformRequest: [
            (data, headers) => {
              delete headers["Content-Type"];
              delete headers["content-type"];
              return data;
            },
          ],
        }
      );

      console.log(`Deleted: ${email}`);
      console.log(response.data);
    } catch (error) {
      console.log(`Failed: ${email}`);
      console.log(error?.response?.data || error.message);
    }
  }

  console.log("\nDone. Sophia Green was kept.");
}

main().catch((error) => {
  console.error(error?.response?.data || error.message);
  process.exit(1);
});