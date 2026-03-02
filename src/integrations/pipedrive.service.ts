// src/integrations/pipedrive.service.ts
import axios, { AxiosInstance } from 'axios';

interface PipedriveConfig {
  apiToken: string;
  apiUrl: string;
}

interface CreatePersonDto {
  name: string;
  email: string;
  phone: string;
}

interface CreateDealDto {
  title: string;
  person_id: number;
  value: number;
  currency?: string;
  stage_id?: number;
}

interface UpdateDealDto {
  title?: string;
  value?: number;
  stage_id?: number;
  [key: string]: any;
}

export class PipedriveService {
  private api: AxiosInstance;
  private apiToken: string;

  constructor() {
    this.apiToken = process.env.PIPEDRIVE_API_TOKEN || '';
    const baseURL = process.env.PIPEDRIVE_API_URL || 'https://api.pipedrive.com/v1';

    this.api = axios.create({
      baseURL,
      params: {
        api_token: this.apiToken,
      },
    });
  }

  // Persons
  async createPerson(data: CreatePersonDto) {
    try {
      const response = await this.api.post('/persons', data);
      return response.data.data;
    } catch (error: any) {
      console.error('Pipedrive createPerson error:', error.response?.data || error.message);
      throw new Error(`Failed to create person in Pipedrive: ${error.message}`);
    }
  }

  async getPerson(id: number) {
    try {
      const response = await this.api.get(`/persons/${id}`);
      return response.data.data;
    } catch (error: any) {
      console.error('Pipedrive getPerson error:', error.response?.data || error.message);
      throw new Error(`Failed to get person from Pipedrive: ${error.message}`);
    }
  }

  async updatePerson(id: number, data: Partial<CreatePersonDto>) {
    try {
      const response = await this.api.put(`/persons/${id}`, data);
      return response.data.data;
    } catch (error: any) {
      console.error('Pipedrive updatePerson error:', error.response?.data || error.message);
      throw new Error(`Failed to update person in Pipedrive: ${error.message}`);
    }
  }

  async deletePerson(id: number) {
    try {
      const response = await this.api.delete(`/persons/${id}`);
      return response.data.data;
    } catch (error: any) {
      console.error('Pipedrive deletePerson error:', error.response?.data || error.message);
      throw new Error(`Failed to delete person from Pipedrive: ${error.message}`);
    }
  }

  // Deals
  async createDeal(data: CreateDealDto) {
    try {
      const response = await this.api.post('/deals', {
        ...data,
        currency: data.currency || 'EUR',
      });
      return response.data.data;
    } catch (error: any) {
      console.error('Pipedrive createDeal error:', error.response?.data || error.message);
      throw new Error(`Failed to create deal in Pipedrive: ${error.message}`);
    }
  }

  async getDeal(id: number) {
    try {
      const response = await this.api.get(`/deals/${id}`);
      return response.data.data;
    } catch (error: any) {
      console.error('Pipedrive getDeal error:', error.response?.data || error.message);
      throw new Error(`Failed to get deal from Pipedrive: ${error.message}`);
    }
  }

  async updateDeal(id: number, data: UpdateDealDto) {
    try {
      const response = await this.api.put(`/deals/${id}`, data);
      return response.data.data;
    } catch (error: any) {
      console.error('Pipedrive updateDeal error:', error.response?.data || error.message);
      throw new Error(`Failed to update deal in Pipedrive: ${error.message}`);
    }
  }

  async deleteDeal(id: number) {
    try {
      const response = await this.api.delete(`/deals/${id}`);
      return response.data.data;
    } catch (error: any) {
      console.error('Pipedrive deleteDeal error:', error.response?.data || error.message);
      throw new Error(`Failed to delete deal from Pipedrive: ${error.message}`);
    }
  }

  async moveDeal(dealId: number, stageId: number) {
    return await this.updateDeal(dealId, { stage_id: stageId });
  }

  // Notes
  async addNote(dealId: number, content: string) {
    try {
      const response = await this.api.post('/notes', {
        content,
        deal_id: dealId,
      });
      return response.data.data;
    } catch (error: any) {
      console.error('Pipedrive addNote error:', error.response?.data || error.message);
      throw new Error(`Failed to add note in Pipedrive: ${error.message}`);
    }
  }

  // Helper: Create Lead (Person + Deal)
  async createLead(data: {
    name: string;
    email: string;
    phone: string;
    source: string;
    value?: number;
  }) {
    try {
      // 1. Create person
      const person = await this.createPerson({
        name: data.name,
        email: data.email,
        phone: data.phone,
      });

      // 2. Create deal
      const deal = await this.createDeal({
        title: `${data.name} - ${data.source}`,
        person_id: person.id,
        value: data.value || 0,
        currency: 'EUR',
      //  stage_id: 1, // "Neuer Lead" stage (adjust based on your Pipedrive setup)
      });

      return { person, deal };
    } catch (error: any) {
      console.error('Pipedrive createLead error:', error.message);
      throw error;
    }
  }
}

export const pipedriveService = new PipedriveService();
