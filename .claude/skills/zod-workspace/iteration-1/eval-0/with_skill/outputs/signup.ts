import { z } from 'zod'

/**
 * Signup form schema.
 *
 * - `email`: required, must be a valid email address.
 * - `password`: required, at least 8 characters.
 * - `confirmPassword`: required, must exactly match `password`. The mismatch
 *   check is a `.refine()` with an explicit `path`, so the resulting issue is
 *   attached to `confirmPassword` instead of the object as a whole — that is
 *   what lets `flatten().fieldErrors.confirmPassword` (rather than
 *   `formErrors`) pick it up.
 */
export const signupSchema = z
  .object({
    email: z
      .string({
        required_error: 'Email is required',
        invalid_type_error: 'Email must be text',
      })
      .min(1, 'Email is required')
      .email('Please enter a valid email address'),

    password: z
      .string({
        required_error: 'Password is required',
        invalid_type_error: 'Password must be text',
      })
      .min(8, 'Password must be at least 8 characters'),

    confirmPassword: z.string({
      required_error: 'Please confirm your password',
      invalid_type_error: 'Password must be text',
    }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })

// Inferred type — single source of truth, drives useState and the submit handler.
export type SignupFormData = z.infer<typeof signupSchema>

/** Field-level error messages, one array of messages per form field. */
export type SignupFormFieldErrors = z.inferFlattenedErrors<
  typeof signupSchema
>['fieldErrors']

export type SignupParseResult =
  | { success: true; data: SignupFormData }
  | { success: false; fieldErrors: SignupFormFieldErrors }

/**
 * Validates raw form values and returns either the parsed data or a
 * field-keyed error map ready to render under each input.
 *
 * Uses safeParse() (never parse()) because this data comes straight from
 * user input — a thrown ZodError has no place in a form submit handler.
 */
export function parseSignupForm(input: unknown): SignupParseResult {
  const result = signupSchema.safeParse(input)

  if (!result.success) {
    const { fieldErrors } = result.error.flatten()
    return { success: false, fieldErrors }
  }

  return { success: true, data: result.data }
}

/*
Usage in a Next.js client component:

  'use client'
  import { useState } from 'react'
  import {
    signupSchema,
    parseSignupForm,
    type SignupFormData,
    type SignupFormFieldErrors,
  } from './signup'

  const emptyForm: SignupFormData = {
    email: '',
    password: '',
    confirmPassword: '',
  }

  export function SignupForm() {
    const [form, setForm] = useState<SignupFormData>(emptyForm)
    const [errors, setErrors] = useState<SignupFormFieldErrors>({})

    function handleSubmit(e: React.FormEvent) {
      e.preventDefault()

      const result = parseSignupForm(form)
      if (!result.success) {
        setErrors(result.fieldErrors)
        return
      }

      setErrors({})
      // result.data is fully typed SignupFormData — submit it.
    }

    return (
      <form onSubmit={handleSubmit}>
        <input
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
        {errors.email?.[0] && <p>{errors.email[0]}</p>}

        <input
          type="password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
        {errors.password?.[0] && <p>{errors.password[0]}</p>}

        <input
          type="password"
          value={form.confirmPassword}
          onChange={(e) =>
            setForm({ ...form, confirmPassword: e.target.value })
          }
        />
        {errors.confirmPassword?.[0] && <p>{errors.confirmPassword[0]}</p>}

        <button type="submit">Sign up</button>
      </form>
    )
  }
*/
