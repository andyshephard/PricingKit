import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchPPPData,
  GDP_PPP_INDICATOR,
  HOUSEHOLD_PPP_INDICATOR,
} from '../ppp';

describe('World Bank PPP data', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defines separate GDP and household final-consumption indicators', () => {
    expect(GDP_PPP_INDICATOR).toBe('PA.NUS.PPP');
    expect(HOUSEHOLD_PPP_INDICATOR).toBe('PA.NUS.PRVT.PP');
  });

  it('requests household PPP data and maps supported territories', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            page: 1,
            pages: 1,
            per_page: 300,
            total: 2,
            sourceid: '2',
            lastupdated: '2026-07-30',
          },
          [
            {
              indicator: { id: HOUSEHOLD_PPP_INDICATOR, value: 'PPP conversion factor, private consumption' },
              country: { id: 'US', value: 'United States' },
              countryiso3code: 'USA',
              date: '2024',
              value: 1,
              unit: '',
              obs_status: '',
              decimal: 0,
            },
            {
              indicator: { id: HOUSEHOLD_PPP_INDICATOR, value: 'PPP conversion factor, private consumption' },
              country: { id: 'IN', value: 'India' },
              countryiso3code: 'IND',
              date: '2024',
              value: 19.9,
              unit: '',
              obs_status: '',
              decimal: 0,
            },
          ],
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const data = await fetchPPPData();

    expect(fetchMock).toHaveBeenCalledOnce();
    const requestedUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestedUrl).toContain('PA.NUS.PRVT.PP');
    expect(requestedUrl).toContain('mrv=1');
    expect(requestedUrl).not.toContain('mrnev=1');
    expect(requestedUrl).not.toContain('source=2');
    expect(data).toEqual([
      { regionCode: 'US', pppConversionFactor: 1, year: 2024 },
      { regionCode: 'IN', pppConversionFactor: 19.9, year: 2024 },
    ]);
  });

  it('requests GDP PPP independently when selected', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            page: 1,
            pages: 1,
            per_page: 300,
            total: 1,
            sourceid: '2',
            lastupdated: '2026-07-30',
          },
          [
            {
              indicator: { id: GDP_PPP_INDICATOR, value: 'PPP conversion factor, GDP' },
              country: { id: 'IN', value: 'India' },
              countryiso3code: 'IND',
              date: '2025',
              value: 20.5,
              unit: '',
              obs_status: '',
              decimal: 0,
            },
          ],
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const data = await fetchPPPData(GDP_PPP_INDICATOR);

    const requestedUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestedUrl).toContain('PA.NUS.PPP');
    expect(requestedUrl).not.toContain('PA.NUS.PRVT.PP');
    expect(data).toEqual([
      { regionCode: 'IN', pppConversionFactor: 20.5, year: 2025 },
    ]);
  });
});
