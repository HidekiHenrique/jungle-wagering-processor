import { Injectable } from '@nestjs/common';

@Injectable()
export class Greeter {
  greet(name: string): string {
    return `hello ${name}`;
  }
}
