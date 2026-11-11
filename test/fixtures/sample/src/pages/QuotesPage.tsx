import { api } from "../lib/apiClient";

export function useQuotes() {
  return api.get("/api/quotes");
}

export function QuotesPage() {
  const quotes = useQuotes();
  return (
    <main>
      <h1>Quotes</h1>
      <Route path="/quotes" element={<QuotesPage />} />
      <pre>{JSON.stringify(quotes)}</pre>
    </main>
  );
}
