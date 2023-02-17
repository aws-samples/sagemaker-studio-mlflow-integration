import { AWSConfig } from "./types";

export const getAWSConfig = async (basePath: string): Promise<AWSConfig> => {
  try {
    const config = await get<AWSConfig>(`${basePath}awsproxy/awsconfig`);
    return {
      region: config.region,
    };
  } catch {
    const config = await post<AWSConfig>(`${basePath}api/getInstanceConfig`);
    return {
      region: config.region,
    };
  }
};

export const get = <T>(path: string): Promise<T> => {
  const options = { method: "get" };
  return request(new Request(path, options));
};

export const post = <T>(path: string): Promise<T> => {
  const options = { method: "post" };
  return request(new Request(path, options));
};

export const request = async <T>(req: Request): Promise<T> => {
  const res = await fetch(req);
  const text = await res.text();
  const data = text && parse<T | Error>(text);
  if (!res.ok) {
    const error = data as Error;
    throw new Error((error && error.message) || res.statusText);
  }
  return data as T;
};

export const parse = <T>(text: string): T => {
  try {
    return JSON.parse(text);
  } catch {
    return {} as T;
  }
};
