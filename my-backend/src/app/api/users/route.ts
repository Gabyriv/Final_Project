import { NextResponse } from "next/server";
import prisma from "@/config/prisma";
import bcrypt from "bcryptjs";
import { handleServerError } from "@/app/api/errors_handlers/errors";
import { UserSchema } from "../types/types";
import supabase from "@/config/supabase_client";
import { withAuth } from "@/utils/auth-utils";
import type { Session } from '@supabase/supabase-js';

/**
 * @swagger
 * components:
 *   schemas:
 *     ErrorResponse:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *         details:
 *           oneOf:
 *             - type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   code:
 *                     type: string
 *                   message:
 *                     type: string
 *                   path:
 *                     type: array
 *                     items:
 *                       type: string
 *             - type: string
 *     UserResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *         data:
 *           type: object
 *           properties:
 *             id:
 *               type: string
 *             name:
 *               type: string
 *             email:
 *               type: string
 *             role:
 *               type: string
 *               enum: [ADMIN, USER]
 * /api/users:
 *   post:
 *     summary: Create a new user
 *     description: Creates a new user with the provided information
 *     tags:
 *       - Users
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - email
 *               - password
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 2
 *                 maxLength: 50
 *                 pattern: ^[a-zA-Z]+$
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 minLength: 8
 *               role:
 *                 type: string
 *                 enum: [ADMIN, USER]
 *                 default: USER
 *     responses:
 *       201:
 *         description: User created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UserResponse'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Email already exists
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
*/
export async function POST(request: Request) {
    // No auth required for user registration
    try {
        const body = await request.json();
        const validated = UserSchema.parse(body);

        // Force new registrations to be ADMIN role
        const userRole = 'ADMIN';

        try {
            console.log('Attempting to sign up user with email:', validated.email);
            
            // First check if the user already exists in Prisma
            const existingUser = await prisma.user.findUnique({
                where: { email: validated.email }
            });
            
            if (existingUser) {
                return NextResponse.json(
                    { error: 'Email already exists' },
                    { status: 409 }
                );
            }
            
            // Then try to create the user in Supabase
            const { data: authData, error: authError } = await supabase.auth.signUp({
                email: validated.email,
                password: validated.password,
                options: {
                    data: {
                        name: validated.name,
                        role: userRole
                    }
                }
            });

            if (authError) {
                console.error('Supabase auth error:', authError);
                return handleServerError(authError);
            }

            if (!authData.user) {
                console.error('No user returned from Supabase');
                return NextResponse.json(
                    { error: 'Failed to create authentication user' },
                    { status: 500 }
                );
            }
        
            // Check if the user needs to confirm their email
            if (authData.user && !authData.session) {
                // This means the user was created but needs to confirm their email
                console.log('User created in Supabase, awaiting email confirmation');
                
                // We can still create the user in our database
                const hashedPassword = await bcrypt.hash(validated.password, 12);
                
                try {
                    const user = await prisma.user.create({
                        data: {
                            id: authData.user.id,
                            name: validated.name,
                            email: validated.email,
                            password: hashedPassword,
                            role: userRole
                        },
                        select: {
                            id: true,
                            name: true,
                            email: true,
                            role: true
                        }
                    });
                    
                    return NextResponse.json({ 
                        success: true, 
                        data: user,
                        message: 'User created. Please check your email to confirm your account.'
                    }, { status: 201 });
                } catch (prismaError) {
                    console.error('Error creating user in Prisma:', prismaError);
                    
                    // Try to delete the user from Supabase since we couldn't create in Prisma
                    try {
                        await supabase.auth.admin.deleteUser(authData.user.id);
                    } catch (deleteError) {
                        console.error('Failed to delete user from Supabase after Prisma error:', deleteError);
                    }
                    
                    return handleServerError(prismaError);
                }
            }
            
            // If we have a session, the user was created and automatically signed in
            const hashedPassword = await bcrypt.hash(validated.password, 12);
        
            const user = await prisma.user.create({
                data: {
                    id: authData.user.id,
                    name: validated.name,
                    email: validated.email,
                    password: hashedPassword,
                    role: userRole
                },
                select: {
                    id: true,
                    name: true,
                    email: true,
                    role: true
                }
            })

            return NextResponse.json({ success: true, data: user }, { status: 201 })
        } catch (error) {
            console.error('Error creating user:', error);
            return handleServerError(error);
        }
    } catch (error) {
        return handleServerError(error)
    }
}

/**
 * @swagger
 * /api/users:
 *   get:
 *     summary: Get all users
 *     description: Retrieves a list of all users
 *     tags:
 *       - Users
 *     responses:
 *       200:
 *         description: List of users retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/UserResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
export async function GET() {
    // Only admins can list all users
    return withAuth(async (session: Session) => {
        try {
            if (session.user.role !== 'ADMIN') {
                return NextResponse.json(
                    { error: 'Only administrators can view all users' },
                    { status: 403 }
                );
            }

            const users = await prisma.user.findMany({
                select: {
                    id: true,
                    name: true,
                    email: true,
                    role: true,
                    createdAt: true,
                    createdTeams: {
                        select: {
                            id: true,
                            name: true
                        }
                    }
                }
            });
            
            return NextResponse.json({ success: true, data: users }, { status: 200 });
        } catch (error) {
            return handleServerError(error);
        }
    }, 'ADMIN');
}
