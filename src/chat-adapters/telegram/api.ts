const TELEGRAM_API = "https://api.telegram.org";

export async function sendTelegramTextMessage(
  token: string,
  chatId: number,
  text: string,
): Promise<void> {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: String(text ?? "").trim() || "Done.",
      disable_web_page_preview: true,
    }),
  });
  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`Telegram send failed (${response.status}): ${payload}`);
  }
}

export async function fetchTelegramImageAsDataUrl(
  token: string,
  fileId: string,
): Promise<string | null> {
  const getFileResponse = await fetch(
    `${TELEGRAM_API}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
  );
  if (!getFileResponse.ok) return null;

  const fileJson = (await getFileResponse.json()) as { result?: { file_path?: string } };
  const filePath = fileJson.result?.file_path;
  if (!filePath) return null;

  const imageResponse = await fetch(`${TELEGRAM_API}/file/bot${token}/${filePath}`);
  if (!imageResponse.ok) return null;

  const contentType = imageResponse.headers.get("content-type") ?? "image/jpeg";
  const bytes = new Uint8Array(await imageResponse.arrayBuffer());
  return `data:${contentType};base64,${bytesToBase64(bytes)}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
