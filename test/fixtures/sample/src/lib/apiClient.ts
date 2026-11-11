export const api = {
  get(path: string) {
    return fetch(path);
  },
  post(path: string, body: unknown) {
    return fetch(path, { method: "POST", body: JSON.stringify(body) });
  },
};
