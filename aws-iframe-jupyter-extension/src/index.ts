import { initiateExtension } from "./aws_iframe_extension";

export const getPaths = async (region: string): Promise<string[]> => {
  return [""];
};

const extension = initiateExtension(getPaths);

export default extension;
