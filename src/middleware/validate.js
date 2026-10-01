// This is a MIDDLEWARE that checks the incoming request data BEFORE your route
// handler runs. If the data is wrong, the request is stopped with a 400 error
// and a clear list of what is wrong. Your handler only ever sees clean data.
// It uses zod (the same library used in env.js) to define the rules.
//
// How it works:
//   validate(schema) returns a middleware. You give it a zod schema that
//   describes what body, query, and params should look like.
//   Then, for each request:
//     1. It collects the 3 places data can come from:
//          body     JSON sent in the request  (POST/PUT data)
//          query    the part after "?" in the URL  (?city=Delhi)
//          params   parts of the URL path  (/events/:id)
//     2. schema.safeParse() checks them against your rules.
//        "safe" means it does not throw an error, it returns a result instead.
//     3. If the check FAILS:
//          - each problem is turned into { field, message }
//          - the request stops with 400 "Validation failed" + that list
//          - errorHandler.js sends it to the user as "details"
//     4. If the check PASSES:
//          - the clean, converted data is saved in req.validated
//          - next() continues to the route handler

import AppError from "../utils/AppError.js";

const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse({
    body: req.body,
    query: req.query,
    params: req.params,
  });

  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    }));
    return next(new AppError("Validation failed", 400, details));
  }

  req.validated = result.data;
  next();
};

export default validate;
