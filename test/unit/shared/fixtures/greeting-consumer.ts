import { Injectable } from '@nestjs/common';
// Imported from another file and used only as a constructor type: the case where
// a wrong `import type` or a transpiler without emitDecoratorMetadata silently breaks DI.
import { Greeter } from './greeter';

@Injectable()
export class GreetingConsumer {
  constructor(readonly greeter: Greeter) {}
}
