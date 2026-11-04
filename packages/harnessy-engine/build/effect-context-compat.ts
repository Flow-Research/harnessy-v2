import * as RootContext from "../../../node_modules/effect/dist/Context";

const servicePrototype = Object.getPrototypeOf(RootContext.Service("@harnessy/engine/compat")) as {
  asEffect?: () => unknown;
};
if (!servicePrototype.asEffect) {
  Object.defineProperty(servicePrototype, "asEffect", {
    value(this: unknown) {
      return this;
    },
  });
}

export * from "../../../node_modules/effect/dist/Context";
