import dotenv from "dotenv";
dotenv.config();

const DEFAULT_PORT = 8080;

export function getPort(): number {
  const envPort: string | undefined = process.env.PORT;
  if (envPort) {
    return Number(envPort);
  }
  return DEFAULT_PORT;
}

export function getMAXBinaryMessageSize(): number {
  return Number(process.env.MAXIMUM_BINARY_MESSAGE_SIZE) || 64000;
}

export function getMinBinaryMessageSize(): number {
  return Number(process.env.MINIMUM_BINARY_MESSAGE_SIZE) || 1000;
}

export function getNoInputTimeout(): number {
  return Number(process.env.NO_INPUT_TIMEOUT) || 30000;
}
