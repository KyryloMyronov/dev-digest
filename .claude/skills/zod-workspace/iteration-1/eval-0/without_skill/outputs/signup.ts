import { z } from "zod";

export const signupSchema = z
  .object({
    email: z
      .string({ required_error: "Email is required" })
      .min(1, "Email is required")
      .email("Please enter a valid email address"),
    password: z
      .string({ required_error: "Password is required" })
      .min(8, "Password must be at least 8 characters"),
    confirmPassword: z
      .string({ required_error: "Please confirm your password" })
      .min(1, "Please confirm your password"),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export type SignupFormData = z.infer<typeof signupSchema>;

export type SignupFieldErrors = Partial<
  Record<keyof SignupFormData, string>
>;

/**
 * Validates raw signup form input and returns either the parsed data
 * or a map of field-level error messages suitable for rendering under
 * each input.
 */
export function validateSignupForm(
  formData: unknown
): { success: true; data: SignupFormData } | { success: false; errors: SignupFieldErrors } {
  const result = signupSchema.safeParse(formData);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors: SignupFieldErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0] as keyof SignupFormData | undefined;
    if (field && !errors[field]) {
      errors[field] = issue.message;
    }
  }

  return { success: false, errors };
}

/**
 * Example usage in a Next.js client component:
 *
 * const [formData, setFormData] = useState<SignupFormData>({
 *   email: "",
 *   password: "",
 *   confirmPassword: "",
 * });
 * const [fieldErrors, setFieldErrors] = useState<SignupFieldErrors>({});
 *
 * function handleSubmit(e: React.FormEvent) {
 *   e.preventDefault();
 *   const result = validateSignupForm(formData);
 *
 *   if (!result.success) {
 *     setFieldErrors(result.errors);
 *     return;
 *   }
 *
 *   setFieldErrors({});
 *   // result.data is now a validated SignupFormData — submit it.
 * }
 *
 * // In JSX, render errors under each input:
 * // {fieldErrors.email && <p className="error">{fieldErrors.email}</p>}
 */
