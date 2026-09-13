declare global {
  const Bun: {
    password: {
      hash(
        password: string,
        options: { algorithm: "argon2id" },
      ): Promise<string>;
      verify(password: string, hash: string): Promise<boolean>;
    };
    file(path: string | URL): { json(): Promise<any> };
  };
  namespace Express {
    interface Request {
      requestId: string;
      auth?: { userId: string; role: "requester" | "manager" };
    }
  }
}
export {};
